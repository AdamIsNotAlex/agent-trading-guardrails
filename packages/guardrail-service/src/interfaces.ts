import type {
  DynamicRiskResult,
  PolicyInput,
  PolicyOutput,
  ReviewerVerdictSchema,
  TradingIntent,
} from "@guardrails/schemas";

export interface ReviewerAdapter {
  review(intent: TradingIntent): Promise<ReviewerVerdictSchema>;
}

export interface PolicyEvaluator {
  evaluate(input: PolicyInput): Promise<unknown>;
  isHealthy(): Promise<boolean>;
}

export interface RiskEngine {
  evaluate(
    intent: TradingIntent,
    reviewerVerdict: ReviewerVerdictSchema,
  ): Promise<DynamicRiskResult>;
}

export type DecisionOutcome = "allow" | "deny" | "needs_human";

export interface GuardrailDecision {
  intentId: string;
  correlationId: string;
  outcome: DecisionOutcome;
  reasons: Array<{ rule: string; message: string }>;
  requiresHumanApproval: boolean;
  reviewerVerdict: ReviewerVerdictSchema | null;
  policyOutput: PolicyOutput | null;
  riskResult: DynamicRiskResult | null;
  decidedAt: string;
}
