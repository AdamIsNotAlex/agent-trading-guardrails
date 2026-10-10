import { randomUUID } from "node:crypto";
import type { BrokerDryRunResult } from "@guardrails/broker";
import {
  DynamicRiskResult,
  PolicyOutput,
  ReviewerVerdictSchema,
  TradingIntent,
} from "@guardrails/schemas";
import type { GuardrailDecision } from "@guardrails/service";
import { z } from "zod";

const decisionSchema = z.object({
  dryRun: z.literal(true),
  intentId: z.string(),
  correlationId: z.string(),
  outcome: z.enum(["allow", "deny", "needs_human"]),
  reasons: z.array(z.object({ rule: z.string(), message: z.string() })),
  requiresHumanApproval: z.boolean(),
  reviewerVerdict: ReviewerVerdictSchema.nullable(),
  policyOutput: PolicyOutput.nullable(),
  riskResult: DynamicRiskResult.nullable(),
  decidedAt: z.string().datetime(),
  decisionToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  approvalId: z.never().optional(),
});

const brokerReportSchema = z.object({
  dryRun: z.literal(true),
  intentId: z.string().uuid(),
  correlationId: z.string(),
  checkedAt: z.string().datetime(),
  passed: z.boolean(),
  requiresHumanApproval: z.boolean(),
  checks: z
    .array(z.object({ check: z.string(), passed: z.boolean(), message: z.string().optional() }))
    .min(1),
  authorization: z
    .object({
      checkedAt: z.string().datetime(),
      token: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});

type StageName = "validation" | "review" | "risk" | "policy" | "broker_revalidation";
interface DryRunStage {
  stage: StageName;
  status: "passed" | "failed" | "skipped";
  message: string;
}

export interface CanaryDryRunReport {
  dryRun: true;
  status: "ready" | "needs_human" | "blocked";
  correlationId: string;
  generatedAt: string;
  intent: TradingIntent | null;
  stages: DryRunStage[];
  decision: GuardrailDecision | null;
  broker: BrokerDryRunResult | null;
}

function endpoint(origin: string): URL {
  const url = new URL(origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Dry-run endpoints must be trusted HTTP(S) origins.");
  }
  url.pathname = "/dry-run";
  return url;
}

async function post(url: URL, body: unknown, correlationId: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-correlation-id": correlationId },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Dry-run endpoint rejected the request.");
  }
  return response.json();
}

/** Operator-only preview. Never calls /execute and never requests or consumes human approval. */
export async function runCanaryDryRun(
  rawIntent: unknown,
  options: { guardrailUrl?: string; brokerUrl?: string } = {},
): Promise<CanaryDryRunReport> {
  const report: CanaryDryRunReport = {
    dryRun: true,
    status: "blocked",
    correlationId: randomUUID(),
    generatedAt: new Date().toISOString(),
    intent: null,
    stages: [],
    decision: null,
    broker: null,
  };
  const stage = (name: StageName, status: DryRunStage["status"], message: string) => {
    report.stages.push({ stage: name, status, message });
  };
  const skip = (names: StageName[]) => {
    for (const name of names) stage(name, "skipped", "An earlier gate did not pass.");
  };
  const parsed = TradingIntent.safeParse(rawIntent);
  if (
    !parsed.success ||
    parsed.data.environment !== "canary_live" ||
    parsed.data.action !== "cex.place_order"
  ) {
    stage("validation", "failed", "A valid canary_live CEX order intent is required.");
    skip(["review", "risk", "policy", "broker_revalidation"]);
    return report;
  }
  const intent = parsed.data;
  report.intent = intent;
  stage("validation", "passed", "Intent schema and canary order environment are valid.");

  let decision: z.infer<typeof decisionSchema>;
  try {
    decision = decisionSchema.parse(
      await post(
        endpoint(options.guardrailUrl ?? "http://127.0.0.1:3000"),
        intent,
        report.correlationId,
      ),
    );
    if (decision.intentId !== intent.intentId || decision.correlationId !== report.correlationId) {
      throw new Error("Dry-run decision binding mismatch.");
    }
    if (
      decision.outcome !== "deny" &&
      (!decision.decisionToken ||
        !decision.reviewerVerdict ||
        !decision.policyOutput ||
        !decision.riskResult?.passed ||
        decision.policyOutput.decision !== decision.outcome ||
        decision.requiresHumanApproval !== (decision.outcome === "needs_human"))
    ) {
      throw new Error("Incomplete dry-run decision.");
    }
  } catch {
    stage("review", "failed", "Guardrail dry-run is unavailable or returned an invalid decision.");
    skip(["risk", "policy", "broker_revalidation"]);
    return report;
  }
  report.decision = decision;
  const reason = decision.reasons[0]?.rule;
  if (
    [
      "schema_validation",
      "resource_mismatch",
      "environment_mismatch",
      "prompt_injection_detected",
      "hallucinated_data_detected",
    ].includes(reason ?? "")
  ) {
    report.stages[0] = {
      stage: "validation",
      status: "failed",
      message: "Guardrail intent validation failed; inspect decision reasons.",
    };
  }
  stage(
    "review",
    decision.reviewerVerdict ? "passed" : reason === "reviewer_unavailable" ? "failed" : "skipped",
    decision.reviewerVerdict
      ? `Advisory verdict: ${decision.reviewerVerdict.verdict}.`
      : "Review did not complete; inspect decision reasons.",
  );
  stage(
    "risk",
    decision.riskResult
      ? decision.riskResult.passed
        ? "passed"
        : "failed"
      : reason === "risk_check_unavailable"
        ? "failed"
        : "skipped",
    decision.riskResult
      ? "Risk checks are included in decision.riskResult."
      : "Risk evaluation did not complete; inspect decision reasons.",
  );
  stage(
    "policy",
    decision.policyOutput
      ? decision.outcome === "deny"
        ? "failed"
        : "passed"
      : reason === "opa_unavailable" || reason === "policy_evaluation_failed"
        ? "failed"
        : "skipped",
    decision.policyOutput
      ? `Policy outcome: ${decision.outcome}.`
      : "Policy evaluation did not complete; inspect decision reasons.",
  );
  if (decision.outcome === "deny") {
    skip(["broker_revalidation"]);
    return report;
  }

  try {
    const broker = brokerReportSchema.parse(
      await post(
        endpoint(options.brokerUrl ?? "http://127.0.0.1:3001"),
        {
          dryRun: true,
          intent,
          intentId: decision.intentId,
          correlationId: decision.correlationId,
          outcome: decision.outcome,
          decidedAt: decision.decidedAt,
          decisionToken: decision.decisionToken,
        },
        report.correlationId,
      ),
    );
    if (
      broker.intentId !== intent.intentId ||
      broker.correlationId !== report.correlationId ||
      broker.requiresHumanApproval !== decision.requiresHumanApproval ||
      (broker.passed && (!broker.authorization || broker.checks.some((check) => !check.passed))) ||
      (!broker.passed && broker.authorization)
    ) {
      throw new Error("Dry-run broker report binding mismatch.");
    }
    report.broker = broker;
    stage(
      "broker_revalidation",
      broker.passed ? "passed" : "failed",
      "Preflight and connector checks are included in broker.checks.",
    );
    if (broker.passed) report.status = decision.requiresHumanApproval ? "needs_human" : "ready";
  } catch {
    stage(
      "broker_revalidation",
      "failed",
      "Broker dry-run is unavailable or returned an invalid report.",
    );
  }
  return report;
}
