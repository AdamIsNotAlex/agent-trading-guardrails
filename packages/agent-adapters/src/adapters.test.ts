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

function makeCapturingService(capture: (intent: TradingIntent) => void) {
  return new GuardrailService(
    config,
    makeReviewer(),
    makePolicy(),
    {
      async evaluate(intent: TradingIntent): Promise<DynamicRiskResult> {
        capture(intent);
        return {
          intentId: intent.intentId,
          passed: true,
          checks: [{ check: "test", status: "pass" }],
          evaluatedAt: now,
        };
      },
    },
    nullAuditWriter,
  );
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

  it("can query order status", async () => {
    const adapter = new OpenClawAdapter(makeService(), "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("get_order_status", {
      exchange: "binance",
      account: "sub-1",
      orderId: "12345678",
      symbol: "ETH-USDC",
      rationale: "Check order status",
      evidence: ["check-1"],
    });
    expect(result.success).toBe(true);
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

  it("exposes guarded onchain tools", () => {
    const adapter = new OpenClawAdapter(makeService(), "agent.openclaw.alpha", "dev");
    const tools = adapter.getToolDefinitions().map((t) => t.name);
    expect(tools).toContain("request_signature");
    expect(tools).toContain("get_onchain_portfolio");
  });

  it("routes onchain portfolio queries through guardrails", async () => {
    let capturedIntent: TradingIntent | undefined;
    const adapter = new OpenClawAdapter(
      makeCapturingService((intent) => {
        capturedIntent = intent;
      }),
      "agent.openclaw.alpha",
      "dev",
    );

    const result = await adapter.executeTool("get_onchain_portfolio", {
      chain: "ethereum",
      chainEnvironment: "sepolia",
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      rationale: "Check wallet holdings",
      evidence: ["wallet-snapshot-1"],
    });

    expect(result.success).toBe(true);
    expect(capturedIntent).toMatchObject({
      action: "onchain.get_portfolio",
      chain: "ethereum",
      chainEnvironment: "sepolia",
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      resource: "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    });
  });

  it("routes onchain signature requests through guardrails", async () => {
    let capturedIntent: TradingIntent | undefined;
    const adapter = new OpenClawAdapter(
      makeCapturingService((intent) => {
        capturedIntent = intent;
      }),
      "agent.openclaw.alpha",
      "dev",
    );

    const result = await adapter.executeTool("request_signature", {
      chain: "ethereum",
      chainEnvironment: "sepolia",
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      simulationId: "550e8400-e29b-41d4-a716-446655440005",
      maxTokenApprovalAmount: "1000000",
      expectedDeltas: [
        {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          asset: "USDC",
          minDelta: "-1000000",
          maxDelta: "0",
        },
      ],
      rationale: "Request signature after simulation",
      evidence: ["sim-1"],
      intentId: "550e8400-e29b-41d4-a716-446655440006",
      requestedAt: now,
    });

    expect(result.success).toBe(true);
    expect(capturedIntent).toMatchObject({
      intentId: "550e8400-e29b-41d4-a716-446655440006",
      action: "onchain.request_signature",
      chain: "ethereum",
      chainEnvironment: "sepolia",
      requestedAt: now,
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      resource: "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      simulationId: "550e8400-e29b-41d4-a716-446655440005",
      maxTokenApprovalAmount: "1000000",
      expectedDeltas: [
        {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          asset: "USDC",
          minDelta: "-1000000",
          maxDelta: "0",
        },
      ],
    });
  });

  it("fails closed when signing expected deltas are malformed", async () => {
    const adapter = new OpenClawAdapter(makeService(), "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("request_signature", {
      chain: "ethereum",
      chainEnvironment: "sepolia",
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      simulationId: "550e8400-e29b-41d4-a716-446655440005",
      expectedDeltas: "invalid-deltas",
      rationale: "Request signature after simulation",
      evidence: ["sim-1"],
    });

    expect(result.success).toBe(false);
    expect(result.reasons[0].rule).toBe("schema_validation");
  });

  it("fails closed when token approval amount is malformed", async () => {
    const adapter = new OpenClawAdapter(makeService(), "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("request_signature", {
      chain: "ethereum",
      chainEnvironment: "sepolia",
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      simulationId: "550e8400-e29b-41d4-a716-446655440005",
      maxTokenApprovalAmount: { amount: "unlimited" },
      rationale: "Request signature after simulation",
      evidence: ["sim-1"],
    });

    expect(result.success).toBe(false);
    expect(result.reasons[0].rule).toBe("schema_validation");
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

  it("routes onchain signature requests through guardrails", async () => {
    let capturedIntent: TradingIntent | undefined;
    const adapter = new HermesAgentAdapter(
      makeCapturingService((intent) => {
        capturedIntent = intent;
      }),
      "agent.hermes.beta",
      "dev",
    );

    const result = await adapter.executeTool("request_signature", {
      chain: "solana",
      chainEnvironment: "devnet",
      to: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      instructions: [
        {
          programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          type: "transfer",
        },
      ],
      simulationId: "550e8400-e29b-41d4-a716-446655440005",
      expectedDeltas: [
        {
          account: "So11111111111111111111111111111111111111112",
          asset: "SOL",
          minDelta: "-1000000",
          maxDelta: "0",
        },
      ],
      rationale: "Request signature after simulation",
      evidence: ["sim-1"],
    });

    expect(result.success).toBe(true);
    expect(capturedIntent).toMatchObject({
      action: "onchain.request_signature",
      chain: "solana",
      chainEnvironment: "devnet",
      to: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      resource: "onchain:solana:devnet:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      simulationId: "550e8400-e29b-41d4-a716-446655440005",
      expectedDeltas: [
        {
          account: "So11111111111111111111111111111111111111112",
          asset: "SOL",
          minDelta: "-1000000",
          maxDelta: "0",
        },
      ],
    });
    expect(
      capturedIntent && "instructions" in capturedIntent ? capturedIntent.instructions : undefined,
    ).toEqual([
      {
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        type: "transfer",
      },
    ]);
  });

  it("routes onchain portfolio queries through guardrails", async () => {
    let capturedIntent: TradingIntent | undefined;
    const adapter = new HermesAgentAdapter(
      makeCapturingService((intent) => {
        capturedIntent = intent;
      }),
      "agent.hermes.beta",
      "dev",
    );

    const result = await adapter.executeTool("get_onchain_portfolio", {
      chain: "solana",
      chainEnvironment: "devnet",
      address: "So11111111111111111111111111111111111111112",
      rationale: "Check wallet holdings",
      evidence: ["wallet-snapshot-1"],
    });

    expect(result.success).toBe(true);
    expect(capturedIntent).toMatchObject({
      action: "onchain.get_portfolio",
      chain: "solana",
      chainEnvironment: "devnet",
      address: "So11111111111111111111111111111111111111112",
      resource: "onchain:solana:devnet:So11111111111111111111111111111111111111112",
    });
  });

  it("fails closed when signing expected deltas are malformed", async () => {
    const adapter = new HermesAgentAdapter(makeService(), "agent.hermes.beta", "dev");
    const result = await adapter.executeTool("request_signature", {
      chain: "solana",
      chainEnvironment: "devnet",
      to: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      simulationId: "550e8400-e29b-41d4-a716-446655440005",
      expectedDeltas: "invalid-deltas",
      rationale: "Request signature after simulation",
      evidence: ["sim-1"],
    });

    expect(result.success).toBe(false);
    expect(result.reasons[0].rule).toBe("schema_validation");
  });

  it("exposes guarded onchain tools", () => {
    const adapter = new HermesAgentAdapter(makeService(), "agent.hermes.beta", "dev");
    const tools = adapter.getToolDefinitions().map((t) => t.name);
    expect(tools).toContain("request_signature");
    expect(tools).toContain("get_onchain_portfolio");
  });

  it("can query order status", async () => {
    const adapter = new HermesAgentAdapter(makeService(), "agent.hermes.beta", "dev");
    const result = await adapter.executeTool("get_order_status", {
      exchange: "binance",
      account: "sub-2",
      orderId: "12345678",
      symbol: "BTC-USDT",
      rationale: "Check order status",
      evidence: ["check-1"],
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
