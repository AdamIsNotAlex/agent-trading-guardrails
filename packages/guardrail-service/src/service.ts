import type { AuditWriter } from "@guardrails/audit";
import {
  type DynamicRiskResult,
  type PolicyInput,
  type PolicyOutput,
  type ReviewerVerdictSchema,
  ReviewerVerdictSchema as ReviewerVerdictValidator,
  TradingIntent,
} from "@guardrails/schemas";
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
  ) {
    this.config = config;
  }

  private writeAudit(event: Parameters<AuditWriter["write"]>[0]): void {
    this.auditWriter.write(event);
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

  private finalizeDecision(
    intent: TradingIntent,
    decision: GuardrailDecision,
    correlationId = decision.correlationId,
    auditContext: AuditContext = {},
  ): GuardrailDecision {
    const auditedDecision = { ...decision, correlationId };
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
        decision: auditedDecision,
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
      return this.finalizeDecision(intent, cached, correlationId, auditContext);
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
      riskResult = await this.risk.evaluate(intent, reviewerVerdict);
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
      resource: intent.resource,
      environment: intent.environment,
      reviewerVerdict: reviewerVerdict.verdict,
      reviewerRiskLevel: reviewerVerdict.riskLevel,
      reviewerDetectedIssues: reviewerVerdict.detectedIssues,
      dailyNotionalUsd: riskResult.dailyStats?.totalNotionalUsd,
      dailyRealizedLossUsd: riskResult.dailyStats?.realizedLossUsd,
    };

    if ("exchange" in intent) policyInput.exchange = intent.exchange;
    if ("accountMode" in intent) policyInput.accountMode = intent.accountMode;
    if ("symbol" in intent) policyInput.symbol = intent.symbol;
    if ("chain" in intent) policyInput.chain = intent.chain;
    if ("chainEnvironment" in intent) policyInput.chainEnvironment = intent.chainEnvironment;
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

    const finalized = this.finalizeDecision(intent, decision, decision.correlationId, auditContext);
    this.idempotency.set(intent.idempotencyKey, payloadHash, finalized);
    return finalized;
  }
}
