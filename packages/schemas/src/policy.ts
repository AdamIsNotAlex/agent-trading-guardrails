import { z } from "zod";
import { Environment, PolicyDecision, RiskTier } from "./common.js";

export const PolicyInput = z
  .object({
    intentId: z.string().uuid(),
    principal: z.string().min(1),
    action: z.string().min(1),
    resource: z.string().min(1),
    environment: Environment,
    accountMode: z.string().optional(),
    marginType: z.string().optional(),
    exchange: z.string().optional(),
    symbol: z.string().optional(),
    chain: z.string().optional(),
    chainEnvironment: z.string().optional(),
    contractAddress: z.string().optional(),
    programId: z.string().optional(),
    instructionType: z.string().optional(),
    maxNotionalUsd: z.number().finite().optional(),
    leverage: z.number().finite().optional(),
    maxTokenApprovalAmount: z.string().optional(),
    reviewerVerdict: z.string().optional(),
    reviewerRiskLevel: RiskTier.optional(),
    reviewerDetectedIssues: z.array(z.string()).optional(),
    riskCheckResults: z.record(z.unknown()).optional(),
    dailyNotionalUsd: z.number().finite().optional(),
    projectedDailyNotionalUsd: z.number().finite().optional(),
    dailyRealizedLossUsd: z.number().finite().optional(),
  })
  .strict();
export type PolicyInput = z.infer<typeof PolicyInput>;

export const PolicyDenyReason = z
  .object({
    rule: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type PolicyDenyReason = z.infer<typeof PolicyDenyReason>;

export const PolicyOutput = z
  .object({
    decision: PolicyDecision,
    reasons: z.array(PolicyDenyReason),
    requiresHumanApproval: z.boolean(),
    matchedAllowRules: z.array(z.string()),
    matchedDenyRules: z.array(z.string()),
    evaluatedAt: z.string().datetime(),
  })
  .strict()
  .refine((data) => !(data.decision === "allow" && data.requiresHumanApproval), {
    message: "allow decision cannot require human approval",
  })
  .refine((data) => !(data.decision === "deny" && data.requiresHumanApproval), {
    message: "deny decision cannot require human approval; use needs_human instead",
  })
  .refine((data) => data.decision !== "needs_human" || data.requiresHumanApproval, {
    message: "needs_human decision must require human approval",
  });
export type PolicyOutput = z.infer<typeof PolicyOutput>;
