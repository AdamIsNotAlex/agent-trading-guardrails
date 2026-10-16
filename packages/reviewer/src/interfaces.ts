import type { ReviewerVerdictSchema, TradingIntent } from "@guardrails/schemas";

export interface Reviewer {
  review(intent: TradingIntent): Promise<ReviewerVerdictSchema>;
}

export interface LlmProvider {
  complete(prompt: string): Promise<string>;
}

export interface ReviewerConfig {
  model: string;
  provider: string;
}
