import { randomUUID } from "node:crypto";
import {
  DynamicRiskResult,
  PolicyOutput,
  ReviewerVerdictSchema,
  type TradingIntent,
} from "@guardrails/schemas";
import type { GuardrailDecision } from "@guardrails/service";

export const DEFAULT_GUARDRAIL_URL = "http://127.0.0.1:3000";
export const DEFAULT_EVALUATE_TIMEOUT_MS = 30_000;
export const CORRELATION_ID_HEADER = "x-correlation-id";
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const TIMEOUT_REASON = "guardrail-evaluate-timeout";

export type EvaluateHttpErrorCode =
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_response"
  | "interrupted";

export type EvaluateHttpSuccess = {
  ok: true;
  decision: GuardrailDecision;
  correlationId: string;
};

export type EvaluateHttpFailure = {
  ok: false;
  error: EvaluateHttpErrorCode;
  message: string;
  correlationId: string;
};

export type EvaluateHttpResult = EvaluateHttpSuccess | EvaluateHttpFailure;

export interface GuardrailEvaluateClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class GuardrailEvaluateClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;

  constructor(options: GuardrailEvaluateClientOptions = {}) {
    this.baseUrl = parseGuardrailBaseUrl(options.baseUrl ?? DEFAULT_GUARDRAIL_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new Error("Guardrail HTTP timeout must be a positive finite 32-bit delay.");
    }
  }

  evaluateUrl(): URL {
    const url = new URL(this.baseUrl);
    const basePath = this.baseUrl.pathname.replace(/\/$/, "");
    url.pathname = `${basePath}/evaluate`;
    url.search = "";
    url.hash = "";
    return url;
  }

  async evaluate(
    intent: TradingIntent,
    options: { correlationId?: string; signal?: AbortSignal } = {},
  ): Promise<EvaluateHttpResult> {
    const correlationId = options.correlationId ?? randomUUID();
    if (options.signal?.aborted) {
      return {
        ok: false,
        error: "interrupted",
        message: "Guardrail evaluate request was interrupted.",
        correlationId,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(TIMEOUT_REASON), this.timeoutMs);
    const onExternalAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const response = await fetch(this.evaluateUrl(), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          [CORRELATION_ID_HEADER]: correlationId,
        },
        body: JSON.stringify(intent),
        signal: controller.signal,
      });

      const header = response.headers.get(CORRELATION_ID_HEADER);
      const responseCorrelationId =
        header && CORRELATION_ID_PATTERN.test(header) ? header : correlationId;

      if (response.status < 200 || response.status > 299) {
        await discardBody(response);
        return {
          ok: false,
          error: "http_error",
          message: `Guardrail evaluate request failed with HTTP ${response.status}.`,
          correlationId: responseCorrelationId,
        };
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        if (options.signal?.aborted || controller.signal.aborted) {
          throw error;
        }
        return {
          ok: false,
          error: "invalid_response",
          message: "Guardrail evaluate response is not a guardrail decision.",
          correlationId: responseCorrelationId,
        };
      }
      const decision = readGuardrailDecision(parsed);
      if (!decision || decision.intentId !== intent.intentId) {
        return {
          ok: false,
          error: "invalid_response",
          message: "Guardrail evaluate response is not a guardrail decision.",
          correlationId: responseCorrelationId,
        };
      }

      return {
        ok: true,
        decision,
        correlationId: decision.correlationId,
      };
    } catch {
      if (options.signal?.aborted) {
        return {
          ok: false,
          error: "interrupted",
          message: "Guardrail evaluate request was interrupted.",
          correlationId,
        };
      }
      if (controller.signal.reason === TIMEOUT_REASON || controller.signal.aborted) {
        return {
          ok: false,
          error: "timeout",
          message: "Guardrail evaluate request timed out.",
          correlationId,
        };
      }
      return {
        ok: false,
        error: "network_error",
        message: "Guardrail evaluate request failed.",
        correlationId,
      };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

function parseGuardrailBaseUrl(value: string): URL {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("GUARDRAIL_URL must be a valid http or https base URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("GUARDRAIL_URL must be a valid http or https base URL.");
  }
  return url;
}

function readGuardrailDecision(value: unknown): GuardrailDecision | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (!("intentId" in value) || typeof value.intentId !== "string") return undefined;
  if (!("correlationId" in value) || typeof value.correlationId !== "string") {
    return undefined;
  }
  if (!("outcome" in value) || typeof value.outcome !== "string") return undefined;
  if (!isDecisionOutcome(value.outcome)) return undefined;
  if (!("reasons" in value) || !Array.isArray(value.reasons)) return undefined;
  if (!("requiresHumanApproval" in value) || typeof value.requiresHumanApproval !== "boolean") {
    return undefined;
  }
  if (!("decidedAt" in value) || typeof value.decidedAt !== "string") return undefined;

  const reasons: GuardrailDecision["reasons"] = [];
  for (const item of value.reasons) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return undefined;
    }
    if (!("rule" in item) || typeof item.rule !== "string") return undefined;
    if (!("message" in item) || typeof item.message !== "string") return undefined;
    reasons.push({ rule: item.rule, message: item.message });
  }

  const reviewerVerdict = readNullableSchema(
    ReviewerVerdictSchema,
    "reviewerVerdict" in value ? value.reviewerVerdict : undefined,
  );
  const policyOutput = readNullableSchema(
    PolicyOutput,
    "policyOutput" in value ? value.policyOutput : undefined,
  );
  const riskResult = readNullableSchema(
    DynamicRiskResult,
    "riskResult" in value ? value.riskResult : undefined,
  );
  if (reviewerVerdict === undefined || policyOutput === undefined || riskResult === undefined) {
    return undefined;
  }

  const decision: GuardrailDecision = {
    intentId: value.intentId,
    correlationId: value.correlationId,
    outcome: value.outcome,
    reasons,
    requiresHumanApproval: value.requiresHumanApproval,
    reviewerVerdict,
    policyOutput,
    riskResult,
    decidedAt: value.decidedAt,
  };
  if ("approvalId" in value && typeof value.approvalId === "string") {
    decision.approvalId = value.approvalId;
  }
  if ("decisionToken" in value && typeof value.decisionToken === "string") {
    decision.decisionToken = value.decisionToken;
  }
  return decision;
}

function readNullableSchema<T>(
  schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false } },
  value: unknown,
): T | null | undefined {
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isDecisionOutcome(value: string): value is GuardrailDecision["outcome"] {
  return value === "allow" || value === "deny" || value === "needs_human";
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Body may already be consumed or closed; never surface it.
  }
}
