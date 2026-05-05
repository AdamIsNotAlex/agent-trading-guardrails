import { createHmac } from "node:crypto";
import { ApprovalStore } from "@guardrails/approval";
import type { AuditWriter } from "@guardrails/audit";
import {
  type DynamicRiskResult,
  DynamicRiskResult as DynamicRiskResultValidator,
  type PolicyInput,
  type PolicyOutput,
  type ReviewerVerdictSchema,
  ReviewerVerdictSchema as ReviewerVerdictValidator,
  TradingIntent,
} from "@guardrails/schemas";
import { redactObject } from "@guardrails/secrets";
import type { GuardrailConfig } from "./config.js";
import { generateCorrelationId } from "./correlation.js";
import { hashPayload, IdempotencyStore } from "./idempotency.js";
import type {
  GuardrailDecision,
  PolicyEvaluator,
  ReviewerAdapter,
  RiskEngine,
} from "./interfaces.js";
import { transformOpaOutput } from "./opa-transform.js";

type AuditContext = Pick<
  Parameters<AuditWriter["write"]>[0],
  "promptId" | "sessionId" | "inputRef"
>;

export class GuardrailService {
  private idempotency = new IdempotencyStore();
  readonly config: GuardrailConfig;

  constructor(
    config: GuardrailConfig,
    private reviewer: ReviewerAdapter,
    private policy: PolicyEvaluator,
    private risk: RiskEngine,
    private auditWriter: Pick<AuditWriter, "write">,
    private approvalStore = new ApprovalStore({
      defaultTimeoutSeconds: config.approvalTimeoutSeconds,
      audit: auditWriter,
    }),
  ) {
    assertDecisionSecret(config.environment, config.decisionSigningSecret);
    this.config = config;
  }

  private writeAudit(event: Parameters<AuditWriter["write"]>[0]): void {
    this.auditWriter.write({
      ...event,
      data: redactObject(event.data) as Record<string, unknown>,
    });
  }

  private finalizeInvalidDecision(
    decision: GuardrailDecision,
    auditContext: AuditContext = {},
  ): GuardrailDecision {
    this.writeAudit({
      eventType: "decision.final",
      environment: this.config.environment,
      correlationId: decision.correlationId,
      promptId: auditContext.promptId,
      sessionId: auditContext.sessionId,
      inputRef: auditContext.inputRef,
      data: {
        outcome: decision.outcome,
        reasons: decision.reasons,
        requiresHumanApproval: decision.requiresHumanApproval,
        decision,
      },
    });
    return decision;
  }

  private requestHumanApproval(
    intent: TradingIntent,
    decision: GuardrailDecision,
    auditContext: AuditContext = {},
  ): GuardrailDecision {
    const request = this.approvalStore.create({
      intentId: intent.intentId,
      correlationId: decision.correlationId,
      principal: intent.principal,
      action: intent.action,
      resource: intent.resource,
      environment: intent.environment,
      escalationReason: decision.reasons[0]?.message ?? "Policy requires human approval.",
      approvalType: "one_time",
      intentData: intent as Record<string, unknown>,
    });
    try {
      this.writeAudit({
        eventType: "approval.requested",
        environment: intent.environment,
        correlationId: decision.correlationId,
        intentId: intent.intentId,
        principal: intent.principal,
        promptId: auditContext.promptId,
        sessionId: auditContext.sessionId,
        inputRef: auditContext.inputRef,
        data: { approvalRequest: request },
      });
    } catch (err) {
      this.approvalStore.delete(request.approvalId);
      throw err;
    }
    return { ...decision, approvalId: request.approvalId };
  }

  waitForApproval(approvalId: string, timeoutMs = this.config.approvalTimeoutSeconds * 1000) {
    return this.approvalStore.waitForApproval(approvalId, timeoutMs);
  }

  private detectUnsafeContent(intent: TradingIntent): { rule: string; message: string } | null {
    const content = [intent.rationale, ...intent.evidence].join("\n").toLowerCase();
    if (
      [
        /ignore\s+all\s+previous\s+instructions/,
        /system\s+override\s*:/,
        /execute\s+cex\.withdraw/,
        /secretly\s+calls\s+cex\.withdraw/,
        /transfer\s+all\s+funds\s+to/,
        /log\s+all\s+environment\s+variables\s+including\s+secrets/,
      ].some((indicator) => indicator.test(content))
    ) {
      return {
        rule: "prompt_injection_detected",
        message: "Intent rationale or evidence contains prompt injection instructions.",
      };
    }
    if (
      [
        /(price|balance|position).{0,120}no snapshot reference/,
        /account\s+has.{0,120}available.{0,120}no portfolio snapshot/,
        /current\s+position\s+is.{0,120}long.{0,120}evidence:\s*none/,
      ].some((indicator) => indicator.test(content))
    ) {
      return {
        rule: "hallucinated_data_detected",
        message: "Intent rationale or evidence contains unsupported market or portfolio claims.",
      };
    }
    return null;
  }

  private extractSolanaInstructionType(intent: TradingIntent): string | undefined {
    if (intent.action !== "onchain.request_signature" || intent.chain !== "solana") {
      return undefined;
    }
    if (!intent.instructions || intent.instructions.length === 0) {
      return "unknown";
    }

    let hasTransfer = false;
    let hasUnknown = false;
    for (const instruction of intent.instructions) {
      if (typeof instruction.type !== "string" || instruction.type.length === 0) {
        hasUnknown = true;
        continue;
      }
      const type = instruction.type;
      if (type === "setAuthority" || type === "SetAuthority" || type === "authority_change") {
        return "setAuthority";
      }
      if (type === "transfer") {
        hasTransfer = true;
        continue;
      }
      hasUnknown = true;
    }

    return hasUnknown ? "unknown" : hasTransfer ? "transfer" : "unknown";
  }

  private canonicalResource(intent: TradingIntent): string | null {
    if ("exchange" in intent && "account" in intent) {
      if ("symbol" in intent) return `cex:${intent.exchange}:${intent.account}:${intent.symbol}`;
      return `cex:${intent.exchange}:${intent.account}`;
    }
    if ("chain" in intent && "chainEnvironment" in intent) {
      const target = "to" in intent ? intent.to : "address" in intent ? intent.address : "";
      return `onchain:${intent.chain}:${intent.chainEnvironment}:${target}`;
    }
    return null;
  }

  private projectedDailyNotionalUsd(
    intent: TradingIntent,
    dailyStats: { totalNotionalUsd: number } | null | undefined,
  ): number | undefined {
    if (intent.action !== "cex.place_order" || !("maxNotionalUsd" in intent) || !dailyStats) {
      return undefined;
    }
    return dailyStats.totalNotionalUsd + intent.maxNotionalUsd;
  }

  private createDecisionToken(
    intent: TradingIntent,
    decision: GuardrailDecision,
    correlationId: string,
  ): string | undefined {
    if (decision.outcome !== "allow" && decision.outcome !== "needs_human") return undefined;
    return createHmac("sha256", this.config.decisionSigningSecret)
      .update(
        stableJson({
          intent,
          outcome: decision.outcome,
          correlationId,
          decidedAt: decision.decidedAt,
          approvalId: decision.approvalId ?? null,
        }),
      )
      .digest("hex");
  }

  private finalizeDecision(
    intent: TradingIntent,
    decision: GuardrailDecision,
    correlationId = decision.correlationId,
    auditContext: AuditContext = {},
  ): GuardrailDecision {
    const decisionToken = this.createDecisionToken(intent, decision, correlationId);
    const auditedDecision = {
      ...decision,
      correlationId,
      decisionToken,
    };
    const auditDecision = decisionToken
      ? { ...auditedDecision, decisionToken: `[sha256:${hashString(decisionToken)}]` }
      : auditedDecision;
    this.writeAudit({
      eventType: "decision.final",
      environment: intent.environment,
      correlationId,
      intentId: intent.intentId,
      principal: intent.principal,
      promptId: auditContext.promptId,
      sessionId: auditContext.sessionId,
      inputRef: auditContext.inputRef,
      data: {
        outcome: auditedDecision.outcome,
        reasons: auditedDecision.reasons,
        requiresHumanApproval: auditedDecision.requiresHumanApproval,
        decision: auditDecision,
      },
    });
    return auditedDecision;
  }

  async health(): Promise<{ status: "ok" | "degraded"; opaHealthy: boolean }> {
    let opaHealthy: boolean;
    try {
      opaHealthy = await this.policy.isHealthy();
    } catch {
      opaHealthy = false;
    }
    return {
      status: opaHealthy ? "ok" : "degraded",
      opaHealthy,
    };
  }

  async evaluate(rawIntent: unknown, auditContext: AuditContext = {}): Promise<GuardrailDecision> {
    const correlationId = generateCorrelationId();
    const now = new Date().toISOString();

    const parseResult = TradingIntent.safeParse(rawIntent);
    if (!parseResult.success) {
      return this.finalizeInvalidDecision(
        {
          intentId: "",
          correlationId,
          outcome: "deny",
          reasons: parseResult.error.issues.map((issue) => ({
            rule: "schema_validation",
            message: `${issue.path.join(".")}: ${issue.message}`,
          })),
          requiresHumanApproval: false,
          reviewerVerdict: null,
          policyOutput: null,
          riskResult: null,
          decidedAt: now,
        },
        auditContext,
      );
    }

    const intent = parseResult.data;
    const canonicalResource = this.canonicalResource(intent);
    if (canonicalResource && intent.resource !== canonicalResource) {
      return this.finalizeInvalidDecision(
        {
          intentId: intent.intentId,
          correlationId,
          outcome: "deny",
          reasons: [
            {
              rule: "resource_mismatch",
              message: "Intent resource does not match intent fields.",
            },
          ],
          requiresHumanApproval: false,
          reviewerVerdict: null,
          policyOutput: null,
          riskResult: null,
          decidedAt: now,
        },
        auditContext,
      );
    }
    if (intent.environment !== this.config.environment) {
      return this.finalizeInvalidDecision(
        {
          intentId: intent.intentId,
          correlationId,
          outcome: "deny",
          reasons: [
            {
              rule: "environment_mismatch",
              message: "Intent environment does not match guardrail service environment.",
            },
          ],
          requiresHumanApproval: false,
          reviewerVerdict: null,
          policyOutput: null,
          riskResult: null,
          decidedAt: now,
        },
        auditContext,
      );
    }

    this.writeAudit({
      eventType: "intent.received",
      environment: intent.environment,
      correlationId,
      intentId: intent.intentId,
      principal: intent.principal,
      promptId: auditContext.promptId,
      sessionId: auditContext.sessionId,
      inputRef: auditContext.inputRef ?? intent.evidence[0],
      data: { intent, correlationId },
    });

    const payloadHash = hashPayload(rawIntent);
    const cached = this.idempotency.get(intent.idempotencyKey, payloadHash);
    if (cached === "conflict") {
      return this.finalizeDecision(
        intent,
        {
          intentId: intent.intentId,
          correlationId,
          outcome: "deny",
          reasons: [
            {
              rule: "idempotency_conflict",
              message: "Idempotency key reused with different payload.",
            },
          ],
          requiresHumanApproval: false,
          reviewerVerdict: null,
          policyOutput: null,
          riskResult: null,
          decidedAt: now,
        },
        correlationId,
        auditContext,
      );
    }
    if (cached) {
      const cachedDecision = cached instanceof Promise ? await cached : cached;
      return this.finalizeDecision(intent, cachedDecision, correlationId, auditContext);
    }
    this.idempotency.reserve(intent.idempotencyKey, payloadHash);

    try {
      const contentRejection = this.detectUnsafeContent(intent);
      if (contentRejection) {
        const decision: GuardrailDecision = {
          intentId: intent.intentId,
          correlationId,
          outcome: "deny",
          reasons: [contentRejection],
          requiresHumanApproval: false,
          reviewerVerdict: null,
          policyOutput: null,
          riskResult: null,
          decidedAt: now,
        };
        const finalized = this.finalizeDecision(
          intent,
          decision,
          decision.correlationId,
          auditContext,
        );
        this.idempotency.set(intent.idempotencyKey, payloadHash, finalized);
        return finalized;
      }

      let opaHealthy: boolean;
      try {
        opaHealthy = await this.policy.isHealthy();
      } catch {
        opaHealthy = false;
      }
      if (!opaHealthy) {
        const decision: GuardrailDecision = {
          intentId: intent.intentId,
          correlationId,
          outcome: "deny",
          reasons: [{ rule: "opa_unavailable", message: "Policy engine is unavailable." }],
          requiresHumanApproval: false,
          reviewerVerdict: null,
          policyOutput: null,
          riskResult: null,
          decidedAt: now,
        };
        const finalized = this.finalizeDecision(
          intent,
          decision,
          decision.correlationId,
          auditContext,
        );
        this.idempotency.set(intent.idempotencyKey, payloadHash, finalized);
        return finalized;
      }

      let reviewerVerdict: ReviewerVerdictSchema;
      try {
        const rawVerdict = await this.reviewer.review(intent);
        reviewerVerdict = ReviewerVerdictValidator.parse(rawVerdict);
      } catch {
        const decision: GuardrailDecision = {
          intentId: intent.intentId,
          correlationId,
          outcome: "deny",
          reasons: [{ rule: "reviewer_unavailable", message: "Reviewer agent is unavailable." }],
          requiresHumanApproval: false,
          reviewerVerdict: null,
          policyOutput: null,
          riskResult: null,
          decidedAt: now,
        };
        const finalized = this.finalizeDecision(
          intent,
          decision,
          decision.correlationId,
          auditContext,
        );
        this.idempotency.set(intent.idempotencyKey, payloadHash, finalized);
        return finalized;
      }
      this.writeAudit({
        eventType: "reviewer.completed",
        environment: intent.environment,
        correlationId,
        intentId: intent.intentId,
        principal: intent.principal,
        promptId: auditContext.promptId,
        sessionId: auditContext.sessionId,
        inputRef: auditContext.inputRef,
        data: { reviewerVerdict },
      });

      let riskResult: DynamicRiskResult;
      try {
        riskResult = DynamicRiskResultValidator.parse(
          await this.risk.evaluate(intent, reviewerVerdict),
        );
      } catch {
        const decision: GuardrailDecision = {
          intentId: intent.intentId,
          correlationId,
          outcome: "deny",
          reasons: [
            { rule: "risk_check_unavailable", message: "Required risk facts are unavailable." },
          ],
          requiresHumanApproval: false,
          reviewerVerdict,
          policyOutput: null,
          riskResult: null,
          decidedAt: now,
        };
        const finalized = this.finalizeDecision(
          intent,
          decision,
          decision.correlationId,
          auditContext,
        );
        this.idempotency.set(intent.idempotencyKey, payloadHash, finalized);
        return finalized;
      }
      this.writeAudit({
        eventType: "risk.evaluated",
        environment: intent.environment,
        correlationId,
        intentId: intent.intentId,
        principal: intent.principal,
        promptId: auditContext.promptId,
        sessionId: auditContext.sessionId,
        inputRef: auditContext.inputRef,
        data: { riskResult, riskChecks: riskResult.checks },
      });

      if (!riskResult.passed) {
        const decision: GuardrailDecision = {
          intentId: intent.intentId,
          correlationId,
          outcome: "deny",
          reasons: riskResult.checks
            .filter((c) => c.status !== "pass")
            .map((c) => ({
              rule: `risk_${c.check}`,
              message: c.message ?? `Risk check ${c.check} failed.`,
            })),
          requiresHumanApproval: false,
          reviewerVerdict,
          policyOutput: null,
          riskResult,
          decidedAt: now,
        };
        const finalized = this.finalizeDecision(
          intent,
          decision,
          decision.correlationId,
          auditContext,
        );
        this.idempotency.set(intent.idempotencyKey, payloadHash, finalized);
        return finalized;
      }

      const policyInput: PolicyInput = {
        intentId: intent.intentId,
        principal: intent.principal,
        action: intent.action,
        resource: canonicalResource ?? intent.resource,
        environment: intent.environment,
        reviewerVerdict: reviewerVerdict.verdict,
        reviewerRiskLevel: reviewerVerdict.riskLevel,
        reviewerDetectedIssues: reviewerVerdict.detectedIssues,
        dailyNotionalUsd: riskResult.dailyStats?.totalNotionalUsd,
        projectedDailyNotionalUsd: this.projectedDailyNotionalUsd(intent, riskResult.dailyStats),
        dailyRealizedLossUsd: riskResult.dailyStats?.realizedLossUsd,
      };

      if ("exchange" in intent) policyInput.exchange = intent.exchange;
      if ("accountMode" in intent) policyInput.accountMode = intent.accountMode;
      if ("marginType" in intent) policyInput.marginType = intent.marginType;
      if ("symbol" in intent) policyInput.symbol = intent.symbol;
      if ("chain" in intent) policyInput.chain = intent.chain;
      if ("chainEnvironment" in intent) policyInput.chainEnvironment = intent.chainEnvironment;
      if ("to" in intent && intent.chain === "ethereum") policyInput.contractAddress = intent.to;
      if ("programId" in intent && intent.programId) policyInput.programId = intent.programId;
      const instructionType = this.extractSolanaInstructionType(intent);
      if (instructionType) policyInput.instructionType = instructionType;
      if ("maxNotionalUsd" in intent) policyInput.maxNotionalUsd = intent.maxNotionalUsd;
      if ("leverage" in intent && intent.leverage != null) policyInput.leverage = intent.leverage;
      if ("maxTokenApprovalAmount" in intent)
        policyInput.maxTokenApprovalAmount = intent.maxTokenApprovalAmount;

      let policyOutput: PolicyOutput;
      try {
        const rawPolicy = await this.policy.evaluate(policyInput);
        policyOutput = transformOpaOutput(rawPolicy as Record<string, unknown>);
      } catch {
        const decision: GuardrailDecision = {
          intentId: intent.intentId,
          correlationId,
          outcome: "deny",
          reasons: [{ rule: "policy_evaluation_failed", message: "Policy evaluation failed." }],
          requiresHumanApproval: false,
          reviewerVerdict,
          policyOutput: null,
          riskResult,
          decidedAt: now,
        };
        const finalized = this.finalizeDecision(
          intent,
          decision,
          decision.correlationId,
          auditContext,
        );
        this.idempotency.set(intent.idempotencyKey, payloadHash, finalized);
        return finalized;
      }
      this.writeAudit({
        eventType: "policy.evaluated",
        environment: intent.environment,
        correlationId,
        intentId: intent.intentId,
        principal: intent.principal,
        promptId: auditContext.promptId,
        sessionId: auditContext.sessionId,
        inputRef: auditContext.inputRef,
        data: { policyInput, opaInput: policyInput, policyOutput },
      });

      const decision: GuardrailDecision = {
        intentId: intent.intentId,
        correlationId,
        outcome: policyOutput.decision,
        reasons: policyOutput.reasons,
        requiresHumanApproval: policyOutput.requiresHumanApproval,
        reviewerVerdict,
        policyOutput,
        riskResult,
        decidedAt: now,
      };

      const approvalDecision =
        decision.outcome === "needs_human"
          ? this.requestHumanApproval(intent, decision, auditContext)
          : decision;
      let finalized: GuardrailDecision;
      try {
        finalized = this.finalizeDecision(
          intent,
          approvalDecision,
          approvalDecision.correlationId,
          auditContext,
        );
      } catch (err) {
        if (approvalDecision.approvalId) {
          this.approvalStore.delete(approvalDecision.approvalId);
        }
        this.idempotency.abort(intent.idempotencyKey, payloadHash, err);
        throw err;
      }
      this.idempotency.set(intent.idempotencyKey, payloadHash, finalized);
      return finalized;
    } catch (err) {
      this.idempotency.abort(intent.idempotencyKey, payloadHash, err);
      throw err;
    }
  }
}

function assertDecisionSecret(environment: string, secret: string): void {
  if (secret.length === 0) {
    throw new Error("Guardrail decision signing secret is required.");
  }
  if (environment !== "dev" && secret === "dev-decision-secret") {
    throw new Error("Default guardrail decision signing secret cannot be used outside dev.");
  }
  if (environment !== "dev" && secret.length < 32) {
    throw new Error(
      "Guardrail decision signing secret must be at least 32 characters outside dev.",
    );
  }
}

function hashString(value: string): string {
  return createHmac("sha256", "audit-token-fingerprint").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
