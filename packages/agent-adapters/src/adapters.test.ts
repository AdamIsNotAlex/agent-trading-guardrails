import type {
  DynamicRiskResult,
  PolicyInput,
  PolicyOutput,
  ReviewerVerdictSchema,
  TradingIntent,
} from "@guardrails/schemas";
import {
  type GuardrailConfig,
  GuardrailService,
  type PolicyEvaluator,
  type ReviewerAdapter as ReviewerAdapterInterface,
  type RiskEngine,
} from "@guardrails/service";
import { describe, expect, it } from "vitest";
import { HermesAgentAdapter } from "./hermes-adapter.js";
import { OpenClawAdapter } from "./openclaw-adapter.js";

const config: GuardrailConfig = {
  environment: "dev",
  opaUrl: "http://localhost:8181",
  approvalTimeoutSeconds: 300,
};
const now = "2026-05-04T12:00:00.000Z";
const nullAuditWriter = { write() {} };

function makeReviewer(): ReviewerAdapterInterface {
  return {
    async review(intent: TradingIntent): Promise<ReviewerVerdictSchema> {
      return {
        intentId: intent.intentId,
        verdict: "approve",
        riskLevel: "low",
        reasons: ["OK"],
        detectedIssues: [],
        requiredPolicyTags: [],
        reviewerModel: "gpt-5.5",
        reviewerProvider: "openai",
        reviewedAt: now,
      };
    },
  };
}

function makePolicy(): PolicyEvaluator {
  return {
    async evaluate(_input: PolicyInput): Promise<PolicyOutput> {
      return {
        decision: "allow",
        reasons: [],
        requiresHumanApproval: false,
        matchedAllowRules: ["dev-all"],
        matchedDenyRules: [],
        evaluatedAt: now,
      };
    },
    async isHealthy() {
      return true;
    },
  };
}

function makeRisk(): RiskEngine {
  return {
    async evaluate(intent: TradingIntent): Promise<DynamicRiskResult> {
      return {
        intentId: intent.intentId,
        passed: true,
        checks: [{ check: "test", status: "pass" }],
        evaluatedAt: now,
      };
    },
  };
}

function makeService() {
  return new GuardrailService(config, makeReviewer(), makePolicy(), makeRisk(), nullAuditWriter);
}

describe("OpenClawAdapter", () => {
  it("can propose a valid order intent", async () => {
    const adapter = new OpenClawAdapter(makeService(), "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("propose_order", {
      exchange: "binance",
      account: "sub-1",
      accountMode: "spot",
      symbol: "ETH-USDC",
      side: "buy",
      orderType: "limit",
      quantity: 0.002,
      price: 3500,
      maxNotionalUsd: 7,
      maxSlippageBps: 30,
      rationale: "Test order",
      evidence: ["snapshot-1"],
    });
    expect(result.success).toBe(true);
    expect(result.outcome).toBe("allow");
    expect(result.intentId).toBeTruthy();
    expect(result.correlationId).toBeTruthy();
  });

  it("can query open orders", async () => {
    const adapter = new OpenClawAdapter(makeService(), "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("get_open_orders", {
      exchange: "binance",
      account: "sub-1",
      rationale: "Check orders",
      evidence: ["check-1"],
    });
    expect(result.success).toBe(true);
  });

  it("can query portfolio", async () => {
    const adapter = new OpenClawAdapter(makeService(), "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("get_portfolio", {
      exchange: "binance",
      account: "sub-1",
      rationale: "Check portfolio",
      evidence: ["check-1"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown tools", async () => {
    const adapter = new OpenClawAdapter(makeService(), "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("direct_cex_access", {});
    expect(result.success).toBe(false);
    expect(result.reasons[0].rule).toBe("unknown_tool");
  });

  it("does not expose CEX tools", () => {
    const adapter = new OpenClawAdapter(makeService(), "agent.openclaw.alpha", "dev");
    const tools = adapter.getToolDefinitions().map((t) => t.name);
    expect(tools).not.toContain("direct_cex_access");
    expect(tools).not.toContain("get_api_key");
    expect(tools).not.toContain("sign_transaction");
  });

  it("does not expose keys or execution paths", () => {
    const adapter = new OpenClawAdapter(
      makeService(),
      "agent.openclaw.alpha",
      "dev",
    ) as unknown as Record<string, unknown>;
    expect(adapter).not.toHaveProperty("apiKey");
    expect(adapter).not.toHaveProperty("apiSecret");
    expect(adapter).not.toHaveProperty("privateKey");
    expect(adapter).not.toHaveProperty("signer");
    expect(adapter).not.toHaveProperty("broker");
    expect(adapter).not.toHaveProperty("connector");
  });

  it("returns structured reject reasons", async () => {
    const denySvc = new GuardrailService(
      config,
      makeReviewer(),
      {
        async evaluate() {
          return {
            decision: "deny" as const,
            reasons: [{ rule: "test-deny", message: "Denied." }],
            requiresHumanApproval: false,
            matchedAllowRules: [],
            matchedDenyRules: ["test-deny"],
            evaluatedAt: now,
          };
        },
        async isHealthy() {
          return true;
        },
      },
      makeRisk(),
      nullAuditWriter,
    );
    const adapter = new OpenClawAdapter(denySvc, "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("propose_order", {
      exchange: "binance",
      account: "sub-1",
      accountMode: "spot",
      symbol: "ETH-USDC",
      side: "buy",
      orderType: "limit",
      maxNotionalUsd: 7,
      maxSlippageBps: 30,
      rationale: "Test",
      evidence: ["snap"],
    });
    expect(result.success).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0].rule).toBe("test-deny");
  });
});

describe("HermesAgentAdapter", () => {
  it("can propose a valid order intent", async () => {
    const adapter = new HermesAgentAdapter(makeService(), "agent.hermes.beta", "dev");
    const result = await adapter.executeTool("propose_order", {
      exchange: "binance",
      account: "sub-2",
      accountMode: "usdm_futures",
      symbol: "BTC-USDT",
      side: "sell",
      orderType: "limit",
      quantity: 0.0001,
      price: 100000,
      maxNotionalUsd: 5,
      maxSlippageBps: 20,
      leverage: 1,
      rationale: "Test futures",
      evidence: ["snapshot-2"],
    });
    expect(result.success).toBe(true);
    expect(result.outcome).toBe("allow");
  });

  it("can simulate onchain transaction", async () => {
    const adapter = new HermesAgentAdapter(makeService(), "agent.hermes.beta", "dev");
    const result = await adapter.executeTool("simulate_transaction", {
      chain: "ethereum",
      chainEnvironment: "sepolia",
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      rationale: "Test simulation",
      evidence: ["snap"],
    });
    expect(result.success).toBe(true);
  });

  it("does not expose direct execution paths", () => {
    const adapter = new HermesAgentAdapter(
      makeService(),
      "agent.hermes.beta",
      "dev",
    ) as unknown as Record<string, unknown>;
    expect(adapter).not.toHaveProperty("apiKey");
    expect(adapter).not.toHaveProperty("privateKey");
    expect(adapter).not.toHaveProperty("broker");
    expect(adapter).not.toHaveProperty("connector");
  });

  it("rejects unknown tools", async () => {
    const adapter = new HermesAgentAdapter(makeService(), "agent.hermes.beta", "dev");
    const result = await adapter.executeTool("rpc_call", {});
    expect(result.success).toBe(false);
  });
});
