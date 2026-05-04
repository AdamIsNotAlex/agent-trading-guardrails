import { z } from "zod";

export const RiskCheckStatus = z.enum(["pass", "fail", "unavailable"]);
export type RiskCheckStatus = z.infer<typeof RiskCheckStatus>;

export const RiskCheckResult = z
  .object({
    check: z.string().min(1),
    status: RiskCheckStatus,
    value: z.unknown().optional(),
    threshold: z.unknown().optional(),
    message: z.string().optional(),
  })
  .strict();
export type RiskCheckResult = z.infer<typeof RiskCheckResult>;

export const DailyRiskStats = z
  .object({
    account: z.string().min(1),
    date: z.string().min(1),
    totalNotionalUsd: z.number(),
    realizedLossUsd: z.number(),
    orderCount: z.number(),
  })
  .strict();
export type DailyRiskStats = z.infer<typeof DailyRiskStats>;

export const DynamicRiskResult = z
  .object({
    intentId: z.string().uuid(),
    passed: z.boolean(),
    checks: z.array(RiskCheckResult).min(1),
    dailyStats: DailyRiskStats.optional(),
    evaluatedAt: z.string().datetime(),
  })
  .strict()
  .refine((data) => data.passed === data.checks.every((c) => c.status === "pass"), {
    message: "passed must equal all checks having status 'pass'",
  });
export type DynamicRiskResult = z.infer<typeof DynamicRiskResult>;
