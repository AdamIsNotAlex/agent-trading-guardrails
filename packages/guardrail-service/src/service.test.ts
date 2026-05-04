import type {
  DynamicRiskResult,
  PolicyInput,
  PolicyOutput,
  ReviewerVerdictSchema,
  TradingIntent,
} from "@guardrails/schemas";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { describe, expect, it } from "vitest";
import type { GuardrailConfig } from "./config.js";
import type { PolicyEvaluator, ReviewerAdapter, RiskEngine } from "./interfaces.js";
import { GuardrailService } from "./service.js";

const now = "2026-05-04T12:00:00.000Z";

const config: GuardrailConfig = {
  environment: "dev",
  opaUrl: "http://localhost:8181",
  approvalTimeoutSeconds: 300,
};

function makeReviewer(
  verdict: ReviewerVerdictSchema["verdict"] = "approve",
  opts?: { shouldThrow?: boolean },
): ReviewerAdapter {
  return {
    async review(intent: TradingIntent): Promise<ReviewerVerdictSchema> {
      if (opts?.shouldThrow) throw new Error("reviewer unavailable");
      return {
        intentId: intent.intentId,
        verdict,
        riskLevel: "low",
        reasons: ["Test review."],
        detectedIssues: [],
        requiredPolicyTags: [],
        reviewerModel: "gpt-5.5",
        reviewerProvider: "openai",
        reviewedAt: now,
      };
    },
  };
}

function makeRisk(pass = true, opts?: { shouldThrow?: boolean }): RiskEngine {
  return {
    async evaluate(intent: TradingIntent): Promise<DynamicRiskResult> {
      if (opts?.shouldThrow) throw new Error("risk data unavailable");
      return {
        intentId: intent.intentId,
        passed: pass,
        checks: [
          {
            check: "market_data_freshness",
            status: pass ? "pass" : "fail",
            value: pass ? 3 : 60,
            threshold: 10,
            message: pass ? undefined : "Market data is stale.",
          },
        ],
        evaluatedAt: now,
      };
    },
  };
}

function makePolicy(
  decision: PolicyOutput["decision"] = "allow",
  opts?: { shouldThrow?: boolean; requiresHuman?: boolean },
): PolicyEvaluator {
  return {
    async evaluate(_input: PolicyInput): Promise<PolicyOutput> {
      if (opts?.shouldThrow) throw new Error("opa error");
      return {
        decision,
        reasons:
          decision === "deny"
            ? [{ rule: "test-deny", message: "Test denial." }]
            : decision === "needs_human"
              ? [{ rule: "test-escalation", message: "Needs human review." }]
              : [],
        requiresHumanApproval: opts?.requiresHuman ?? decision === "needs_human",
        matchedAllowRules: decision === "allow" ? ["test-allow"] : [],
        matchedDenyRules: decision === "deny" ? ["test-deny"] : [],
        evaluatedAt: now,
      };
    },
    async isHealthy(): Promise<boolean> {
      return !opts?.shouldThrow;
    },
  };
}

describe("GuardrailService", () => {
  describe("health", () => {
    it("returns ok when OPA is healthy", async () => {
      const svc = new GuardrailService(config, makeReviewer(), makePolicy(), makeRisk());
      const health = await svc.health();
      expect(health).toEqual({ status: "ok", opaHealthy: true });
    });

    it("returns degraded when OPA is unhealthy", async () => {
      const svc = new GuardrailService(
        config,
        makeReviewer(),
        makePolicy("allow", { shouldThrow: true }),
        makeRisk(),
      );
      const health = await svc.health();
      expect(health).toEqual({ status: "degraded", opaHealthy: false });
    });
  });

  describe("intent validation", () => {
    it("rejects invalid intent with structured reasons", async () => {
      const svc = new GuardrailService(config, makeReviewer(), makePolicy(), makeRisk());
      const result = await svc.evaluate({ action: "invalid", text: "buy ETH" });
      expect(result.outcome).toBe("deny");
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons[0].rule).toBe("schema_validation");
    });

    it("rejects intent with unknown fields", async () => {
      const svc = new GuardrailService(config, makeReviewer(), makePolicy(), makeRisk());
      const result = await svc.evaluate({ ...binanceSpotOrder, extraField: "hacked" });
      expect(result.outcome).toBe("deny");
    });
  });

  describe("allow flow", () => {
    it("allows valid intent through full pipeline", async () => {
      const svc = new GuardrailService(config, makeReviewer(), makePolicy(), makeRisk());
      const result = await svc.evaluate(binanceSpotOrder);
      expect(result.outcome).toBe("allow");
      expect(result.intentId).toBe(binanceSpotOrder.intentId);
      expect(result.correlationId).toBeTruthy();
      expect(result.reviewerVerdict).not.toBeNull();
      expect(result.policyOutput).not.toBeNull();
      expect(result.riskResult).not.toBeNull();
      expect(result.requiresHumanApproval).toBe(false);
    });
  });

  describe("deny flow", () => {
    it("denies when policy says deny", async () => {
      const svc = new GuardrailService(config, makeReviewer(), makePolicy("deny"), makeRisk());
      const result = await svc.evaluate(binanceSpotOrder);
      expect(result.outcome).toBe("deny");
      expect(result.reasons).toContainEqual({ rule: "test-deny", message: "Test denial." });
    });

    it("denies when risk checks fail", async () => {
      const svc = new GuardrailService(config, makeReviewer(), makePolicy(), makeRisk(false));
      const result = await svc.evaluate(binanceSpotOrder);
      expect(result.outcome).toBe("deny");
      expect(result.reasons[0].rule).toBe("risk_market_data_freshness");
    });
  });

  describe("needs_human flow", () => {
    it("returns needs_human when policy escalates", async () => {
      const svc = new GuardrailService(
        config,
        makeReviewer(),
        makePolicy("needs_human"),
        makeRisk(),
      );
      const result = await svc.evaluate(binanceSpotOrder);
      expect(result.outcome).toBe("needs_human");
      expect(result.requiresHumanApproval).toBe(true);
    });
  });

  describe("fail-closed behavior", () => {
    it("denies when OPA is unavailable", async () => {
      const svc = new GuardrailService(
        config,
        makeReviewer(),
        makePolicy("allow", { shouldThrow: true }),
        makeRisk(),
      );
      const result = await svc.evaluate(binanceSpotOrder);
      expect(result.outcome).toBe("deny");
      expect(result.reasons[0].rule).toBe("opa_unavailable");
    });

    it("denies when reviewer is unavailable", async () => {
      const svc = new GuardrailService(
        config,
        makeReviewer("approve", { shouldThrow: true }),
        makePolicy(),
        makeRisk(),
      );
      const result = await svc.evaluate(binanceSpotOrder);
      expect(result.outcome).toBe("deny");
      expect(result.reasons[0].rule).toBe("reviewer_unavailable");
    });

    it("denies when risk facts are unavailable", async () => {
      const svc = new GuardrailService(
        config,
        makeReviewer(),
        makePolicy(),
        makeRisk(true, { shouldThrow: true }),
      );
      const result = await svc.evaluate(binanceSpotOrder);
      expect(result.outcome).toBe("deny");
      expect(result.reasons[0].rule).toBe("risk_check_unavailable");
    });

    it("denies when policy evaluation fails", async () => {
      const badPolicy: PolicyEvaluator = {
        async evaluate() {
          throw new Error("opa internal error");
        },
        async isHealthy() {
          return true;
        },
      };
      const svc = new GuardrailService(config, makeReviewer(), badPolicy, makeRisk());
      const result = await svc.evaluate(binanceSpotOrder);
      expect(result.outcome).toBe("deny");
      expect(result.reasons[0].rule).toBe("policy_evaluation_failed");
    });
  });

  describe("idempotency", () => {
    it("returns cached decision for same idempotency key and payload", async () => {
      const svc = new GuardrailService(config, makeReviewer(), makePolicy(), makeRisk());
      const first = await svc.evaluate(binanceSpotOrder);
      const second = await svc.evaluate(binanceSpotOrder);
      expect(second.outcome).toBe(first.outcome);
      expect(second.correlationId).toBe(first.correlationId);
    });

    it("rejects conflicting payload with same idempotency key", async () => {
      const svc = new GuardrailService(config, makeReviewer(), makePolicy(), makeRisk());
      await svc.evaluate(binanceSpotOrder);
      const conflicting = { ...binanceSpotOrder, maxNotionalUsd: 999 };
      const result = await svc.evaluate(conflicting);
      expect(result.outcome).toBe("deny");
      expect(result.reasons[0].rule).toBe("idempotency_conflict");
    });
  });

  describe("correlation IDs", () => {
    it("assigns unique correlation IDs to each request", async () => {
      const svc = new GuardrailService(config, makeReviewer(), makePolicy(), makeRisk());
      const order1 = { ...binanceSpotOrder, idempotencyKey: "key-1" };
      const order2 = {
        ...binanceSpotOrder,
        idempotencyKey: "key-2",
        intentId: "550e8400-e29b-41d4-a716-446655440099",
      };
      const r1 = await svc.evaluate(order1);
      const r2 = await svc.evaluate(order2);
      expect(r1.correlationId).toBeTruthy();
      expect(r2.correlationId).toBeTruthy();
      expect(r1.correlationId).not.toBe(r2.correlationId);
    });
  });
});
