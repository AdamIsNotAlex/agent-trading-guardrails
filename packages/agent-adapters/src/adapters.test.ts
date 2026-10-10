import { once } from "node:events";
import type { Server } from "node:http";
import type {
  DynamicRiskResult,
  PolicyInput,
  PolicyOutput,
  ReviewerVerdictSchema,
  TradingIntent,
} from "@guardrails/schemas";
import {
  createGuardrailServer,
  type GuardrailConfig,
  GuardrailService,
  type PolicyEvaluator,
  type ReviewerAdapter as ReviewerAdapterInterface,
  type RiskEngine,
} from "@guardrails/service";
import { afterEach, describe, expect, it } from "vitest";
import { HermesAgentAdapter } from "./hermes-adapter.js";
import { GuardrailEvaluateClient } from "./http-client.js";
import { OpenClawAdapter } from "./openclaw-adapter.js";

const config: GuardrailConfig = {
  environment: "dev",
  opaUrl: "http://localhost:8181",
  approvalTimeoutSeconds: 300,
  decisionSigningSecret: "test-decision-secret-with-32-bytes",
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
        reasons: [{ rule: "dev-all", message: "Allowed." }],
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

const servers: Server[] = [];

async function remote(service = makeService()) {
  const server = createGuardrailServer(service);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP listener.");
  return new GuardrailEvaluateClient({ baseUrl: `http://127.0.0.1:${address.port}` });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

describe("OpenClawAdapter", () => {
  it("can propose a valid order intent", async () => {
    const adapter = new OpenClawAdapter(await remote(), "agent.openclaw.alpha", "dev");
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
      idempotencyKey: "adapter-test-1",
    });
    expect(result.success).toBe(true);
    expect(result.outcome).toBe("allow");
    expect(result.intentId).toBeTruthy();
    expect(result.correlationId).toBeTruthy();
  });

  it("passes futures margin type through propose order", async () => {
    let capturedIntent: TradingIntent | undefined;
    const adapter = new OpenClawAdapter(
      await remote(
        makeCapturingService((intent) => {
          capturedIntent = intent;
        }),
      ),
      "agent.openclaw.alpha",
      "dev",
    );

    const result = await adapter.executeTool("propose_order", {
      exchange: "binance",
      account: "sub-1",
      accountMode: "usdm_futures",
      marginType: "isolated",
      symbol: "ETH-USDT",
      side: "buy",
      orderType: "limit",
      quantity: 0.002,
      price: 3500,
      maxNotionalUsd: 7,
      maxSlippageBps: 30,
      leverage: 1,
      rationale: "Test futures order",
      evidence: ["snapshot-1"],
      idempotencyKey: "adapter-test-2",
    });

    expect(result.success).toBe(true);
    expect(capturedIntent).toMatchObject({
      action: "cex.place_order",
      accountMode: "usdm_futures",
      marginType: "isolated",
    });
  });

  it("can query order status", async () => {
    const adapter = new OpenClawAdapter(await remote(), "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("get_order_status", {
      exchange: "binance",
      account: "sub-1",
      orderId: "12345678",
      symbol: "ETH-USDC",
      rationale: "Check order status",
      evidence: ["check-1"],
      idempotencyKey: "adapter-test-3",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown tools", async () => {
    const adapter = new OpenClawAdapter(await remote(), "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("direct_cex_access", {});
    expect(result.success).toBe(false);
    expect(result.reasons[0].rule).toBe("unknown_tool");
  });

  it("routes onchain signature requests through guardrails", async () => {
    let capturedIntent: TradingIntent | undefined;
    const adapter = new OpenClawAdapter(
      await remote(
        makeCapturingService((intent) => {
          capturedIntent = intent;
        }),
      ),
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
      idempotencyKey: "adapter-test-7",
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
    const adapter = new OpenClawAdapter(await remote(), "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("request_signature", {
      chain: "ethereum",
      chainEnvironment: "sepolia",
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      simulationId: "550e8400-e29b-41d4-a716-446655440005",
      expectedDeltas: "invalid-deltas",
      rationale: "Request signature after simulation",
      evidence: ["sim-1"],
      idempotencyKey: "adapter-test-8",
    });

    expect(result.success).toBe(false);
    expect(result.reasons[0].rule).toBe("schema_validation");
  });

  it("fails closed when token approval amount is malformed", async () => {
    const adapter = new OpenClawAdapter(await remote(), "agent.openclaw.alpha", "dev");
    const result = await adapter.executeTool("request_signature", {
      chain: "ethereum",
      chainEnvironment: "sepolia",
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      simulationId: "550e8400-e29b-41d4-a716-446655440005",
      maxTokenApprovalAmount: { amount: "unlimited" },
      rationale: "Request signature after simulation",
      evidence: ["sim-1"],
      idempotencyKey: "adapter-test-9",
    });

    expect(result.success).toBe(false);
    expect(result.reasons[0].rule).toBe("schema_validation");
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
    const adapter = new OpenClawAdapter(await remote(denySvc), "agent.openclaw.alpha", "dev");
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
      rationale: "Test",
      evidence: ["snap"],
      idempotencyKey: "adapter-test-10",
    });
    expect(result.success).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0].rule).toBe("test-deny");
  });
});

describe("HermesAgentAdapter", () => {
  it("can propose a valid order intent", async () => {
    const adapter = new HermesAgentAdapter(await remote(), "agent.hermes.beta", "dev");
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
      marginType: "isolated",
      rationale: "Test futures",
      evidence: ["snapshot-2"],
      idempotencyKey: "adapter-test-11",
    });
    expect(result.success).toBe(true);
    expect(result.outcome).toBe("allow");
  });

  it("can simulate onchain transaction", async () => {
    const adapter = new HermesAgentAdapter(await remote(), "agent.hermes.beta", "dev");
    const result = await adapter.executeTool("simulate_transaction", {
      chain: "ethereum",
      chainEnvironment: "sepolia",
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      rationale: "Test simulation",
      evidence: ["snap"],
      idempotencyKey: "adapter-test-12",
    });
    expect(result.success).toBe(true);
  });

  it("routes onchain signature requests through guardrails", async () => {
    let capturedIntent: TradingIntent | undefined;
    const adapter = new HermesAgentAdapter(
      await remote(
        makeCapturingService((intent) => {
          capturedIntent = intent;
        }),
      ),
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
      idempotencyKey: "adapter-test-13",
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

  it("fails closed when signing expected deltas are malformed", async () => {
    const adapter = new HermesAgentAdapter(await remote(), "agent.hermes.beta", "dev");
    const result = await adapter.executeTool("request_signature", {
      chain: "solana",
      chainEnvironment: "devnet",
      to: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      simulationId: "550e8400-e29b-41d4-a716-446655440005",
      expectedDeltas: "invalid-deltas",
      rationale: "Request signature after simulation",
      evidence: ["sim-1"],
      idempotencyKey: "adapter-test-15",
    });

    expect(result.success).toBe(false);
    expect(result.reasons[0].rule).toBe("schema_validation");
  });

  it("can query order status", async () => {
    const adapter = new HermesAgentAdapter(await remote(), "agent.hermes.beta", "dev");
    const result = await adapter.executeTool("get_order_status", {
      exchange: "binance",
      account: "sub-2",
      orderId: "12345678",
      symbol: "BTC-USDT",
      rationale: "Check order status",
      evidence: ["check-1"],
      idempotencyKey: "adapter-test-16",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown tools", async () => {
    const adapter = new HermesAgentAdapter(await remote(), "agent.hermes.beta", "dev");
    const result = await adapter.executeTool("rpc_call", {});
    expect(result.success).toBe(false);
  });
});
