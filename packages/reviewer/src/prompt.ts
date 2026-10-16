import type { TradingIntent } from "@guardrails/schemas";
import { REVIEWER_ISSUES } from "./issue-definitions.js";

const detectionLabels = Object.entries(REVIEWER_ISSUES)
  .map(([label, description]) => `- "${label}": ${description}`)
  .join("\n");

export function buildReviewerPrompt(intent: TradingIntent): string {
  return `You are a trading guardrail reviewer. Your verdict is ADVISORY ONLY — you cannot sign, trade, approve secrets, or bypass policy. Your role is to detect suspicious patterns.

Review this trading intent and respond with a JSON object matching the schema exactly.

## Intent
${JSON.stringify(intent, null, 2)}

## Detection Labels
Flag any of these issues if detected:
${detectionLabels}

## Response Format
Respond with ONLY a JSON object:
{
  "intentId": "<same as input>",
  "verdict": "approve" | "reject" | "needs_human",
  "riskLevel": "low" | "medium" | "high" | "critical",
  "reasons": ["<explanation>"],
  "detectedIssues": [],
  "requiredPolicyTags": ["<relevant tags>"],
  "reviewerModel": "<model name>",
  "reviewerProvider": "<provider name>",
  "reviewedAt": "<ISO timestamp>"
}`;
}
