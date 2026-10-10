import { createHmac, timingSafeEqual } from "node:crypto";
import type { TradingIntent } from "@guardrails/schemas";
import { hashIntentPayload } from "./idempotency-store.js";
import type { PreflightCheckResult } from "./preflight.js";

const DEFAULT_DRY_RUN_AGE_MS = 5 * 60 * 1000;

export interface GuardrailDryRunApproval {
  dryRun: true;
  intentId: string;
  correlationId: string;
  outcome: "allow" | "needs_human";
  intent: TradingIntent;
  decidedAt: string;
  decisionToken: string;
}

export interface DryRunAuthorization {
  checkedAt: string;
  token: string;
}

export interface BrokerDryRunResult {
  dryRun: true;
  intentId: string;
  correlationId: string;
  checkedAt: string;
  passed: boolean;
  requiresHumanApproval: boolean;
  checks: PreflightCheckResult[];
  authorization?: DryRunAuthorization;
}

export function dryRunIsFresh(checkedAt: string, now: string, decisionMaxAgeMs?: number): boolean {
  const age = Date.parse(now) - Date.parse(checkedAt);
  const maxAgeMs = decisionMaxAgeMs ?? DEFAULT_DRY_RUN_AGE_MS;
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

export function createDryRunAuthorization(
  secret: string,
  intent: TradingIntent,
  checkedAt: string,
): DryRunAuthorization {
  return {
    checkedAt,
    token: createHmac("sha256", secret)
      .update(`broker-dry-run:${hashIntentPayload(intent)}:${checkedAt}`)
      .digest("hex"),
  };
}

export function dryRunAuthorizationMatches(
  authorization: DryRunAuthorization | undefined,
  secret: string,
  intent: TradingIntent,
  now: string,
  decisionMaxAgeMs?: number,
): boolean {
  if (
    !authorization ||
    !/^[a-f0-9]{64}$/.test(authorization.token) ||
    !dryRunIsFresh(authorization.checkedAt, now, decisionMaxAgeMs)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(authorization.token, "hex"),
    Buffer.from(createDryRunAuthorization(secret, intent, authorization.checkedAt).token, "hex"),
  );
}
