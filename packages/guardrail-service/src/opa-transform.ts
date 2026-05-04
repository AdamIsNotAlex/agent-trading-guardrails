import { type PolicyOutput, PolicyOutput as PolicyOutputValidator } from "@guardrails/schemas";

interface RawReason {
  rule?: unknown;
  message?: unknown;
}

function normalizeReasons(value: unknown): PolicyOutput["reasons"] {
  if (!Array.isArray(value)) return [];

  return value.map((reason): PolicyOutput["reasons"][number] => {
    if (typeof reason === "string") {
      return { rule: reason, message: reason };
    }

    const rawReason = reason as RawReason;
    return {
      rule: typeof rawReason.rule === "string" ? rawReason.rule : "policy",
      message: typeof rawReason.message === "string" ? rawReason.message : String(reason),
    };
  });
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function transformOpaOutput(raw: Record<string, unknown>): PolicyOutput {
  const directReasons = normalizeReasons(raw.reasons);
  const reasons =
    directReasons.length > 0
      ? directReasons
      : [...normalizeReasons(raw.hard_deny_reasons), ...normalizeReasons(raw.escalation_reasons)];

  return PolicyOutputValidator.parse({
    decision: raw.decision,
    reasons,
    requiresHumanApproval: raw.requiresHumanApproval ?? raw.requires_human_approval ?? false,
    matchedAllowRules: raw.matchedAllowRules ?? normalizeStringArray(raw.matched_allow_rules),
    matchedDenyRules: raw.matchedDenyRules ?? normalizeStringArray(raw.matched_deny_rules),
    evaluatedAt: raw.evaluatedAt ?? new Date().toISOString(),
  });
}
