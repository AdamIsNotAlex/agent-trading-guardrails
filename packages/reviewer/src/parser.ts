import {
  type ReviewerVerdictSchema as ReviewerVerdict,
  ReviewerVerdictSchema,
} from "@guardrails/schemas";

export function parseReviewerOutput(raw: string): ReviewerVerdict {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Reviewer output does not contain a JSON object.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("Reviewer output contains invalid JSON.");
  }

  return ReviewerVerdictSchema.parse(parsed);
}
