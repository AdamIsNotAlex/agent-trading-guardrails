import { type PolicyOutput, PolicyOutput as PolicyOutputValidator } from "@guardrails/schemas";

interface RawReason {
  rule?: unknown;
  message?: unknown;
}

function normalizeReasons(value: unknown, field: string): PolicyOutput["reasons"] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);

  return value.map((reason): PolicyOutput["reasons"][number] => {
    if (typeof reason === "string") {
      return { rule: reason, message: reason };
    }
    if (!reason || typeof reason !== "object") {
      throw new Error(`${field} entries must be strings or reason objects.`);
    }

    const rawReason = reason as RawReason;
    if (typeof rawReason.rule !== "string" || typeof rawReason.message !== "string") {
      throw new Error(`${field} reason objects must include string rule and message.`);
    }
    return {
      rule: rawReason.rule,
      message: rawReason.message,
    };
  });
}

function normalizeOptionalReasons(value: unknown, field: string): PolicyOutput["reasons"] {
  return value === undefined ? [] : normalizeReasons(value, field);
}

function normalizeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value;
}

function requiredField(raw: Record<string, unknown>, camel: string, snake: string): unknown {
  if (camel in raw) return raw[camel];
  if (snake in raw) return raw[snake];
  throw new Error(`OPA output missing ${snake}.`);
}

function allReasonsMatchRules(reasons: PolicyOutput["reasons"], rules: string[]): boolean {
  const ruleSet = new Set(rules);
  return reasons.every((reason) => ruleSet.has(reason.rule));
}

export function transformOpaOutput(raw: Record<string, unknown>): PolicyOutput {
  if (!("decision" in raw)) throw new Error("OPA output missing decision.");

  const hasDirectReasons = "reasons" in raw;
  const hasMappedReasons = "hard_deny_reasons" in raw || "escalation_reasons" in raw;
  if (!hasDirectReasons && !hasMappedReasons) {
    throw new Error("OPA output missing reasons.");
  }

  const directReasons = hasDirectReasons ? normalizeReasons(raw.reasons, "reasons") : [];
  const hardDenyReasons = normalizeOptionalReasons(raw.hard_deny_reasons, "hard_deny_reasons");
  const reasons = hasDirectReasons
    ? directReasons
    : [
        ...hardDenyReasons,
        ...normalizeOptionalReasons(raw.escalation_reasons, "escalation_reasons"),
      ];
  const requiresHumanApproval = requiredField(
    raw,
    "requiresHumanApproval",
    "requires_human_approval",
  );
  const matchedAllowRules = normalizeStringArray(
    requiredField(raw, "matchedAllowRules", "matched_allow_rules"),
    "matched_allow_rules",
  );
  const matchedDenyRules = normalizeStringArray(
    requiredField(raw, "matchedDenyRules", "matched_deny_rules"),
    "matched_deny_rules",
  );

  const policyOutput = PolicyOutputValidator.parse({
    decision: raw.decision,
    reasons,
    requiresHumanApproval,
    matchedAllowRules,
    matchedDenyRules,
    evaluatedAt: raw.evaluatedAt ?? new Date().toISOString(),
  });

  if (policyOutput.decision !== "deny") {
    if (hardDenyReasons.length > 0 || policyOutput.matchedDenyRules.length > 0) {
      throw new Error("non-deny decision cannot include hard-deny evidence.");
    }
  }
  if (policyOutput.decision === "allow") {
    if (policyOutput.requiresHumanApproval) {
      throw new Error("allow decision cannot require human approval.");
    }
    if (policyOutput.matchedAllowRules.length === 0) {
      throw new Error("allow decision requires matched allow rule evidence.");
    }
    if (policyOutput.reasons.length === 0) {
      throw new Error("allow decision requires at least one allow reason.");
    }
    if (!allReasonsMatchRules(policyOutput.reasons, policyOutput.matchedAllowRules)) {
      throw new Error("allow decision reasons must match allow rule evidence.");
    }
  }
  if (policyOutput.decision === "deny" && policyOutput.reasons.length === 0) {
    throw new Error("deny decision requires at least one deny reason.");
  }
  if (policyOutput.decision === "needs_human" && !policyOutput.requiresHumanApproval) {
    throw new Error("needs_human decision must require human approval.");
  }

  return policyOutput;
}
