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

export class GuardrailService {
  private idempotency = new IdempotencyStore();
  readonly config: GuardrailConfig;

  constructor(
    config: GuardrailConfig,
    private reviewer: ReviewerAdapter,
    private policy: PolicyEvaluator,
    private risk: RiskEngine,
  ) {
    this.config = config;
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

  async evaluate(rawIntent: unknown): Promise<GuardrailDecision> {
    const correlationId = generateCorrelationId();
    const now = new Date().toISOString();

    const parseResult = TradingIntent.safeParse(rawIntent);
    if (!parseResult.success) {
      return {
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
      };
    }

    const intent = parseResult.data;

    const payloadHash = hashPayload(rawIntent);
    const cached = this.idempotency.get(intent.idempotencyKey, payloadHash);
    if (cached === "conflict") {
      return {
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
      };
    }
    if (cached) {
      return cached;
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
      this.idempotency.set(intent.idempotencyKey, payloadHash, decision);
      return decision;
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
      this.idempotency.set(intent.idempotencyKey, payloadHash, decision);
      return decision;
    }

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
      this.idempotency.set(intent.idempotencyKey, payloadHash, decision);
      return decision;
    }

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
      this.idempotency.set(intent.idempotencyKey, payloadHash, decision);
      return decision;
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
      this.idempotency.set(intent.idempotencyKey, payloadHash, decision);
      return decision;
    }

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

    this.idempotency.set(intent.idempotencyKey, payloadHash, decision);
    return decision;
  }
}
