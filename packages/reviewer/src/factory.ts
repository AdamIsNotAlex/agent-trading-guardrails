import { ReviewerAdapter } from "./adapter.js";
import { DecisionReviewerAdapter } from "./decision-reviewer.js";
import { HttpDecisionProvider } from "./http-decision-provider.js";
import type { Reviewer } from "./interfaces.js";
import { OpenAiLlmProvider } from "./openai-provider.js";

export type ReviewerProviderName = "openai" | "openai-decisions" | "jev" | "clef";

export interface ReviewerProviderConfig {
  provider: ReviewerProviderName;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  accountId?: string;
}

export function createReviewer(config: ReviewerProviderConfig): Reviewer {
  let defaultModel: string;
  switch (config.provider) {
    case "openai":
      defaultModel = "gpt-5.5";
      break;
    case "openai-decisions":
      defaultModel = "gpt-6-luna";
      break;
    case "jev":
      defaultModel = "jev-1.13.0";
      break;
    case "clef":
      defaultModel = "clef-flash";
      break;
    default:
      throw new Error("Unsupported reviewer provider.");
  }
  const model = config.model === undefined ? defaultModel : config.model.trim();
  if (!model) throw new Error("Reviewer model must not be empty.");
  const reviewerConfig = { provider: config.provider, model };
  if (config.provider === "openai") {
    return new ReviewerAdapter(
      reviewerConfig,
      new OpenAiLlmProvider({ apiKey: config.apiKey, model, baseUrl: config.baseUrl }),
    );
  }
  return new DecisionReviewerAdapter(
    reviewerConfig,
    new HttpDecisionProvider({ ...config, provider: config.provider, model }),
  );
}
