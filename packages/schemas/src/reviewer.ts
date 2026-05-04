import { z } from "zod";
import { ReviewerVerdict, RiskTier } from "./common.js";

export const DetectedIssue = z.enum([
  "prompt_injection",
  "unsupported_claim",
  "evidence_action_mismatch",
  "suspicious_tool_behavior",
  "hallucinated_data",
  "excessive_risk",
]);
export type DetectedIssue = z.infer<typeof DetectedIssue>;

export const ReviewerVerdictSchema = z
  .object({
    intentId: z.string().uuid(),
    verdict: ReviewerVerdict,
    riskLevel: RiskTier,
    reasons: z.array(z.string().min(1)).min(1),
    detectedIssues: z.array(DetectedIssue),
    requiredPolicyTags: z.array(z.string().min(1)),
    reviewerModel: z.string().min(1),
    reviewerProvider: z.string().min(1),
    reviewedAt: z.string().datetime(),
  })
  .strict();
export type ReviewerVerdictSchema = z.infer<typeof ReviewerVerdictSchema>;
