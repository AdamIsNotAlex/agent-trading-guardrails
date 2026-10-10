import { Environment } from "@guardrails/schemas";
import { z } from "zod";
import type { ApprovalRequest } from "./interfaces.js";

const base = z.object({
  approvalId: z.string().uuid(),
  intentId: z.string(),
  correlationId: z.string(),
  principal: z.string(),
  action: z.string(),
  resource: z.string(),
  environment: Environment,
  escalationReason: z.string(),
  approvalType: z.enum(["one_time", "allowlist_onboarding"]),
  intentData: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  timeoutAt: z.string().datetime(),
});

const decision = { decidedAt: z.string().datetime(), decidedBy: z.string() };

export const approvalRequestSchema: z.ZodType<ApprovalRequest> = z.discriminatedUnion("state", [
  base.extend({ state: z.literal("pending"), decidedAt: z.null(), decidedBy: z.null() }).strict(),
  base.extend({ state: z.literal("approved"), ...decision }).strict(),
  base.extend({ state: z.literal("denied"), ...decision }).strict(),
  base.extend({ state: z.literal("consumed"), ...decision }).strict(),
  base
    .extend({
      state: z.literal("timeout"),
      decidedAt: z.string().datetime(),
      decidedBy: z.null(),
    })
    .strict(),
]);
