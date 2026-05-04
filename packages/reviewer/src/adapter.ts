import type { ReviewerVerdictSchema, TradingIntent } from "@guardrails/schemas";
import type { LlmProvider, ReviewerConfig } from "./interfaces.js";
import { parseReviewerOutput } from "./parser.js";
import { buildReviewerPrompt } from "./prompt.js";

export class ReviewerAdapter {
  constructor(
    readonly config: ReviewerConfig,
    private llm: LlmProvider,
  ) {}

  async review(intent: TradingIntent): Promise<ReviewerVerdictSchema> {
    const prompt = buildReviewerPrompt(intent);
    const raw = await this.llm.complete(prompt);
    return parseReviewerOutput(raw);
  }
}
