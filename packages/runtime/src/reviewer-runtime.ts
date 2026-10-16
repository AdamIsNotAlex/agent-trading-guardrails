import type { ReviewerProviderConfig, ReviewerProviderName } from "@guardrails/reviewer";

function optionalSetting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function requiredCredential(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function reviewerProvider(value: string): ReviewerProviderName {
  if (value === "openai" || value === "openai-decisions" || value === "jev" || value === "clef") {
    return value;
  }
  throw new Error("REVIEWER_PROVIDER must be openai, openai-decisions, jev, or clef.");
}

function credentialName(provider: ReviewerProviderName): string {
  switch (provider) {
    case "openai":
    case "openai-decisions":
      return "OPENAI_API_KEY";
    case "jev":
      return "TYPESAFE_API_KEY";
    case "clef":
      return "CLOUDFLARE_API_TOKEN";
  }
}

export function loadReviewerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ReviewerProviderConfig {
  const rawProvider = env.REVIEWER_PROVIDER;
  const provider = reviewerProvider(rawProvider === undefined ? "openai" : rawProvider.trim());
  const config: ReviewerProviderConfig = {
    provider,
    apiKey: requiredCredential(env, credentialName(provider)),
  };
  const model = optionalSetting(env, "REVIEWER_MODEL");
  if (model !== undefined) config.model = model;
  const baseUrl = optionalSetting(env, "REVIEWER_BASE_URL");
  if (baseUrl !== undefined) config.baseUrl = baseUrl;
  if (provider === "clef") {
    config.accountId = requiredCredential(env, "CLOUDFLARE_ACCOUNT_ID");
  }
  return config;
}
