import { z } from "zod";
import { Environment } from "./common.js";

export const AuditEventType = z.enum([
  "intent.received",
  "intent.validated",
  "intent.rejected",
  "reviewer.started",
  "reviewer.completed",
  "reviewer.failed",
  "policy.evaluated",
  "policy.failed",
  "risk.evaluated",
  "risk.failed",
  "approval.created",
  "approval.decided",
  "approval.timeout",
  "allowlist.updated",
  "signer.requested",
  "signer.completed",
  "signer.failed",
  "broker.revalidated",
  "broker.executed",
  "broker.failed",
  "killswitch.activated",
  "killswitch.blocked",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

export const AuditEvent = z
  .object({
    eventId: z.string().uuid(),
    eventType: AuditEventType,
    timestamp: z.string().datetime(),
    correlationId: z.string().uuid(),
    environment: Environment,
    intentId: z.string().uuid().optional(),
    principal: z.string().optional(),
    data: z.record(z.unknown()),
    previousHash: z.string().min(1),
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEvent>;
