import { describe, expect, it } from "vitest";
import {
  binanceCancelOrder,
  binanceFuturesOrder,
  binanceOrderStatus,
  binanceSpotOrder,
  ethereumSepoliaSigning,
  ethereumSepoliaSimulation,
  solanaDevnetSimulation,
} from "./fixtures.js";
import {
  AuditEvent,
  BrokerExecutionResult,
  CexCancelIntent,
  CexGetOpenOrdersIntent,
  CexGetPortfolioIntent,
  CexOrderIntent,
  CexOrderStatusIntent,
  DynamicRiskResult,
  OnchainQueryIntent,
  OnchainSigningIntent,
  OnchainSimulationIntent,
  PolicyInput,
  PolicyOutput,
  ReviewerVerdictSchema,
  TradingIntent,
} from "./index.js";

const now = "2026-05-04T12:00:00.000Z";
const baseEnvelope = {
  intentId: "550e8400-e29b-41d4-a716-446655440001",
  principal: "agent.openclaw.strategy-alpha",
  resource: "cex:binance:subaccount-1",
  environment: "canary_live" as const,
  requestedAt: now,
  idempotencyKey: "test-001",
  rationale: "Test query.",
  evidence: ["test_evidence"],
};

describe("CexOrderIntent", () => {
  it("accepts valid Binance spot order", () => {
    expect(CexOrderIntent.parse(binanceSpotOrder)).toEqual(binanceSpotOrder);
  });

  it("accepts valid Binance USD-M futures order", () => {
    expect(CexOrderIntent.parse(binanceFuturesOrder)).toEqual(binanceFuturesOrder);
  });

  it("rejects unknown fields (strict mode)", () => {
    expect(() => CexOrderIntent.parse({ ...binanceSpotOrder, unknownField: "hacked" })).toThrow();
  });

  it("rejects missing required fields", () => {
    const { symbol: _, ...incomplete } = binanceSpotOrder;
    expect(() => CexOrderIntent.parse(incomplete)).toThrow();
  });

  it("rejects negative notional", () => {
    expect(() => CexOrderIntent.parse({ ...binanceSpotOrder, maxNotionalUsd: -10 })).toThrow();
  });

  it("rejects empty evidence array", () => {
    expect(() => CexOrderIntent.parse({ ...binanceSpotOrder, evidence: [] })).toThrow();
  });

  it("rejects missing idempotency key", () => {
    const { idempotencyKey: _, ...noKey } = binanceSpotOrder;
    expect(() => CexOrderIntent.parse(noKey)).toThrow();
  });
});

describe("CexCancelIntent", () => {
  it("accepts valid cancel order", () => {
    expect(CexCancelIntent.parse(binanceCancelOrder)).toEqual(binanceCancelOrder);
  });

  it("rejects unknown fields", () => {
    expect(() => CexCancelIntent.parse({ ...binanceCancelOrder, extra: true })).toThrow();
  });
});

describe("CexOrderStatusIntent", () => {
  it("accepts valid order status query", () => {
    expect(CexOrderStatusIntent.parse(binanceOrderStatus)).toEqual(binanceOrderStatus);
  });

  it("rejects unknown fields", () => {
    expect(() => CexOrderStatusIntent.parse({ ...binanceOrderStatus, extra: true })).toThrow();
  });
});

describe("CexGetOpenOrdersIntent", () => {
  it("accepts valid get open orders query", () => {
    const intent = {
      ...baseEnvelope,
      action: "cex.get_open_orders" as const,
      exchange: "binance" as const,
      account: "subaccount-1",
    };
    expect(CexGetOpenOrdersIntent.parse(intent)).toEqual(intent);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      CexGetOpenOrdersIntent.parse({
        ...baseEnvelope,
        action: "cex.get_open_orders" as const,
        exchange: "binance" as const,
        account: "subaccount-1",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("CexGetPortfolioIntent", () => {
  it("accepts valid get portfolio query", () => {
    const intent = {
      ...baseEnvelope,
      action: "cex.get_portfolio" as const,
      exchange: "binance" as const,
      account: "subaccount-1",
    };
    expect(CexGetPortfolioIntent.parse(intent)).toEqual(intent);
  });
});

describe("OnchainQueryIntent", () => {
  it("accepts valid onchain portfolio query", () => {
    const intent = {
      ...baseEnvelope,
      action: "onchain.get_portfolio" as const,
      resource: "onchain:ethereum:sepolia",
      chain: "ethereum" as const,
      chainEnvironment: "sepolia" as const,
      address: "0x1234567890abcdef1234567890abcdef12345678",
    };
    expect(OnchainQueryIntent.parse(intent)).toEqual(intent);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      OnchainQueryIntent.parse({
        ...baseEnvelope,
        action: "onchain.get_portfolio" as const,
        chain: "ethereum" as const,
        chainEnvironment: "sepolia" as const,
        address: "0x1234",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("OnchainSimulationIntent", () => {
  it("accepts valid Ethereum Sepolia simulation", () => {
    expect(OnchainSimulationIntent.parse(ethereumSepoliaSimulation)).toEqual(
      ethereumSepoliaSimulation,
    );
  });

  it("accepts valid Solana devnet simulation", () => {
    expect(OnchainSimulationIntent.parse(solanaDevnetSimulation)).toEqual(solanaDevnetSimulation);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      OnchainSimulationIntent.parse({ ...ethereumSepoliaSimulation, malicious: "payload" }),
    ).toThrow();
  });
});

describe("OnchainSigningIntent", () => {
  it("accepts valid Ethereum Sepolia signing request", () => {
    expect(OnchainSigningIntent.parse(ethereumSepoliaSigning)).toEqual(ethereumSepoliaSigning);
  });

  it("requires simulationId", () => {
    const { simulationId: _, ...noSim } = ethereumSepoliaSigning;
    expect(() => OnchainSigningIntent.parse(noSim)).toThrow();
  });
});

describe("TradingIntent (union)", () => {
  it("parses spot order via union", () => {
    const result = TradingIntent.parse(binanceSpotOrder);
    expect(result.action).toBe("cex.place_order");
  });

  it("parses cancel order via union", () => {
    const result = TradingIntent.parse(binanceCancelOrder);
    expect(result.action).toBe("cex.cancel_order");
  });

  it("parses order status via union", () => {
    const result = TradingIntent.parse(binanceOrderStatus);
    expect(result.action).toBe("cex.get_order_status");
  });

  it("parses get_open_orders via union", () => {
    const intent = {
      ...baseEnvelope,
      action: "cex.get_open_orders" as const,
      exchange: "binance" as const,
      account: "subaccount-1",
    };
    const result = TradingIntent.parse(intent);
    expect(result.action).toBe("cex.get_open_orders");
  });

  it("parses get_portfolio via union", () => {
    const intent = {
      ...baseEnvelope,
      action: "cex.get_portfolio" as const,
      exchange: "binance" as const,
      account: "subaccount-1",
    };
    const result = TradingIntent.parse(intent);
    expect(result.action).toBe("cex.get_portfolio");
  });

  it("parses onchain.get_portfolio via union", () => {
    const intent = {
      ...baseEnvelope,
      action: "onchain.get_portfolio" as const,
      resource: "onchain:ethereum:sepolia",
      chain: "ethereum" as const,
      chainEnvironment: "sepolia" as const,
      address: "0x1234",
    };
    const result = TradingIntent.parse(intent);
    expect(result.action).toBe("onchain.get_portfolio");
  });

  it("parses simulation via union", () => {
    const result = TradingIntent.parse(ethereumSepoliaSimulation);
    expect(result.action).toBe("onchain.simulate_transaction");
  });

  it("parses signing via union", () => {
    const result = TradingIntent.parse(ethereumSepoliaSigning);
    expect(result.action).toBe("onchain.request_signature");
  });

  it("parses Ethereum expected balance deltas", () => {
    const result = TradingIntent.parse({
      ...ethereumSepoliaSimulation,
      expectedDeltas: [
        {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          asset: "USDC",
          minDelta: "-100",
          maxDelta: "-99",
        },
      ],
    });

    if (result.action !== "onchain.simulate_transaction") throw new Error("Unexpected action.");
    expect(result.expectedDeltas).toHaveLength(1);
  });

  it("parses Solana expected balance deltas", () => {
    const result = TradingIntent.parse({
      ...ethereumSepoliaSimulation,
      chain: "solana",
      chainEnvironment: "devnet",
      expectedDeltas: [
        {
          account: "recipient111111111111111111111111111111111",
          asset: "SOL",
          minDelta: "-100",
          maxDelta: "-99",
        },
      ],
    });

    if (result.action !== "onchain.simulate_transaction") throw new Error("Unexpected action.");
    expect(result.expectedDeltas).toHaveLength(1);
  });

  it("rejects malformed onchain expected balance deltas", () => {
    expect(() =>
      TradingIntent.parse({
        ...ethereumSepoliaSigning,
        expectedDeltas: [{ asset: "USDC", minDelta: "-100", maxDelta: "-99" }],
      }),
    ).toThrow();
    expect(() =>
      TradingIntent.parse({
        ...ethereumSepoliaSigning,
        expectedDeltas: [
          {
            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            asset: "USDC",
            minDelta: "-1.5",
            maxDelta: "0",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      TradingIntent.parse({
        ...ethereumSepoliaSigning,
        expectedDeltas: [
          {
            account: "recipient111111111111111111111111111111111",
            asset: "USDC",
            minDelta: "0",
            maxDelta: "0",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      TradingIntent.parse({
        ...ethereumSepoliaSigning,
        expectedDeltas: [
          {
            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            account: "recipient111111111111111111111111111111111",
            asset: "USDC",
            minDelta: "0",
            maxDelta: "0",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects free-form execution request", () => {
    expect(() =>
      TradingIntent.parse({
        action: "execute whatever you want",
        text: "buy 1000 ETH immediately",
      }),
    ).toThrow();
  });

  it("rejects intent with no action", () => {
    expect(() => TradingIntent.parse({ text: "buy ETH" })).toThrow();
  });

  it("rejects intent with unsupported action", () => {
    expect(() =>
      TradingIntent.parse({
        ...binanceSpotOrder,
        action: "cex.withdraw",
      }),
    ).toThrow();
  });
});

describe("ReviewerVerdictSchema", () => {
  const validVerdict = {
    intentId: "550e8400-e29b-41d4-a716-446655440001",
    verdict: "approve",
    riskLevel: "low",
    reasons: ["Intent matches strategy parameters."],
    detectedIssues: [],
    requiredPolicyTags: ["cex.low_notional", "fresh_market_data"],
    reviewerModel: "gpt-5.5",
    reviewerProvider: "openai",
    reviewedAt: "2026-05-04T12:00:01.000Z",
  };

  it("accepts valid verdict", () => {
    expect(ReviewerVerdictSchema.parse(validVerdict)).toEqual(validVerdict);
  });

  it("rejects unknown verdict value", () => {
    expect(() => ReviewerVerdictSchema.parse({ ...validVerdict, verdict: "maybe" })).toThrow();
  });

  it("rejects unknown detected issue", () => {
    expect(() =>
      ReviewerVerdictSchema.parse({
        ...validVerdict,
        detectedIssues: ["unknown_issue_type"],
      }),
    ).toThrow();
  });
});

describe("PolicyInput", () => {
  it("accepts valid policy input", () => {
    const input = {
      intentId: "550e8400-e29b-41d4-a716-446655440001",
      principal: "agent.openclaw.strategy-alpha",
      action: "cex.place_order",
      resource: "cex:binance:subaccount-1:ETH-USDC",
      environment: "canary_live" as const,
      accountMode: "spot",
      exchange: "binance",
      symbol: "ETH-USDC",
      instructionType: "setAuthority",
      maxNotionalUsd: 10,
      reviewerVerdict: "approve",
      reviewerRiskLevel: "low" as const,
      reviewerDetectedIssues: [],
    };
    expect(PolicyInput.parse(input)).toEqual(input);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      PolicyInput.parse({
        intentId: "550e8400-e29b-41d4-a716-446655440001",
        principal: "agent.test",
        action: "cex.place_order",
        resource: "cex:binance:sub:ETH",
        environment: "dev",
        extraField: "not-allowed",
      }),
    ).toThrow();
  });
});

describe("PolicyOutput", () => {
  it("accepts valid allow decision", () => {
    const output = {
      decision: "allow" as const,
      reasons: [],
      requiresHumanApproval: false,
      matchedAllowRules: ["binance-spot-low-notional"],
      matchedDenyRules: [],
      evaluatedAt: "2026-05-04T12:00:02.000Z",
    };
    expect(PolicyOutput.parse(output)).toEqual(output);
  });

  it("accepts valid deny decision", () => {
    const output = {
      decision: "deny" as const,
      reasons: [{ rule: "withdrawal-denied", message: "CEX withdrawals are not permitted." }],
      requiresHumanApproval: false,
      matchedAllowRules: [],
      matchedDenyRules: ["withdrawal-denied"],
      evaluatedAt: "2026-05-04T12:00:02.000Z",
    };
    expect(PolicyOutput.parse(output)).toEqual(output);
  });

  it("accepts valid needs_human decision", () => {
    const output = {
      decision: "needs_human" as const,
      reasons: [{ rule: "new-symbol", message: "Symbol not on allowlist." }],
      requiresHumanApproval: true,
      matchedAllowRules: [],
      matchedDenyRules: [],
      evaluatedAt: "2026-05-04T12:00:02.000Z",
    };
    expect(PolicyOutput.parse(output)).toEqual(output);
  });

  it("rejects allow with requiresHumanApproval", () => {
    expect(() =>
      PolicyOutput.parse({
        decision: "allow",
        reasons: [],
        requiresHumanApproval: true,
        matchedAllowRules: [],
        matchedDenyRules: [],
        evaluatedAt: "2026-05-04T12:00:02.000Z",
      }),
    ).toThrow();
  });

  it("rejects deny with requiresHumanApproval", () => {
    expect(() =>
      PolicyOutput.parse({
        decision: "deny",
        reasons: [{ rule: "test", message: "test" }],
        requiresHumanApproval: true,
        matchedAllowRules: [],
        matchedDenyRules: ["test"],
        evaluatedAt: "2026-05-04T12:00:02.000Z",
      }),
    ).toThrow();
  });
});

describe("DynamicRiskResult", () => {
  it("accepts valid passing risk result", () => {
    const result = {
      intentId: "550e8400-e29b-41d4-a716-446655440001",
      passed: true,
      checks: [
        { check: "market_data_freshness", status: "pass" as const, value: 3, threshold: 10 },
        { check: "per_order_notional", status: "pass" as const, value: 10, threshold: 50 },
      ],
      evaluatedAt: "2026-05-04T12:00:03.000Z",
    };
    expect(DynamicRiskResult.parse(result)).toEqual(result);
  });

  it("accepts valid failing risk result", () => {
    const result = {
      intentId: "550e8400-e29b-41d4-a716-446655440001",
      passed: false,
      checks: [
        { check: "market_data_freshness", status: "fail" as const, value: 60, threshold: 10 },
      ],
      evaluatedAt: "2026-05-04T12:00:03.000Z",
    };
    expect(DynamicRiskResult.parse(result)).toEqual(result);
  });

  it("rejects passed:true with failed checks", () => {
    expect(() =>
      DynamicRiskResult.parse({
        intentId: "550e8400-e29b-41d4-a716-446655440001",
        passed: true,
        checks: [
          { check: "market_data_freshness", status: "fail" as const, value: 60, threshold: 10 },
        ],
        evaluatedAt: "2026-05-04T12:00:03.000Z",
      }),
    ).toThrow();
  });

  it("rejects passed:false with all passing checks", () => {
    expect(() =>
      DynamicRiskResult.parse({
        intentId: "550e8400-e29b-41d4-a716-446655440001",
        passed: false,
        checks: [{ check: "notional", status: "pass" as const }],
        evaluatedAt: "2026-05-04T12:00:03.000Z",
      }),
    ).toThrow();
  });

  it("rejects empty checks array", () => {
    expect(() =>
      DynamicRiskResult.parse({
        intentId: "550e8400-e29b-41d4-a716-446655440001",
        passed: true,
        checks: [],
        evaluatedAt: "2026-05-04T12:00:03.000Z",
      }),
    ).toThrow();
  });
});

describe("BrokerExecutionResult", () => {
  it("accepts valid execution result", () => {
    const result = {
      intentId: "550e8400-e29b-41d4-a716-446655440001",
      idempotencyKey: "spot-order-001",
      status: "executed" as const,
      orderId: "87654321",
      revalidationPassed: true,
      executedAt: "2026-05-04T12:00:04.000Z",
    };
    expect(BrokerExecutionResult.parse(result)).toEqual(result);
  });

  it("accepts execution result with order status details", () => {
    const result = {
      intentId: "550e8400-e29b-41d4-a716-446655440001",
      idempotencyKey: "order-status-001",
      status: "executed" as const,
      orderId: "87654321",
      orderStatus: {
        orderId: "87654321",
        symbol: "ETH-USDC",
        side: "BUY",
        status: "FILLED",
        executedQty: 0.002,
        avgPrice: 3500,
      },
      revalidationPassed: true,
      executedAt: "2026-05-04T12:00:04.000Z",
    };
    expect(BrokerExecutionResult.parse(result)).toEqual(result);
  });

  it("accepts valid rejected result", () => {
    const result = {
      intentId: "550e8400-e29b-41d4-a716-446655440001",
      idempotencyKey: "spot-order-001",
      status: "rejected" as const,
      revalidationPassed: false,
      rejectionReason: "Stale market data.",
      executedAt: "2026-05-04T12:00:04.000Z",
    };
    expect(BrokerExecutionResult.parse(result)).toEqual(result);
  });

  it("rejects executed with revalidationPassed:false", () => {
    expect(() =>
      BrokerExecutionResult.parse({
        intentId: "550e8400-e29b-41d4-a716-446655440001",
        idempotencyKey: "spot-order-001",
        status: "executed",
        revalidationPassed: false,
        executedAt: "2026-05-04T12:00:04.000Z",
      }),
    ).toThrow();
  });
});

describe("AuditEvent", () => {
  it("accepts valid audit event", () => {
    const event = {
      eventId: "660e8400-e29b-41d4-a716-446655440001",
      eventType: "intent.received" as const,
      timestamp: "2026-05-04T12:00:00.000Z",
      correlationId: "770e8400-e29b-41d4-a716-446655440001",
      environment: "canary_live" as const,
      intentId: "550e8400-e29b-41d4-a716-446655440001",
      principal: "agent.openclaw.strategy-alpha",
      data: { action: "cex.place_order", resource: "cex:binance:subaccount-1:ETH-USDC" },
      previousHash: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    expect(AuditEvent.parse(event)).toEqual(event);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      AuditEvent.parse({
        eventId: "660e8400-e29b-41d4-a716-446655440001",
        eventType: "intent.received",
        timestamp: now,
        correlationId: "770e8400-e29b-41d4-a716-446655440001",
        environment: "dev",
        data: {},
        previousHash: "0000",
        extra: "not-allowed",
      }),
    ).toThrow();
  });

  it("rejects invalid event type", () => {
    expect(() =>
      AuditEvent.parse({
        eventId: "660e8400-e29b-41d4-a716-446655440001",
        eventType: "invalid.event",
        timestamp: now,
        correlationId: "770e8400-e29b-41d4-a716-446655440001",
        environment: "dev",
        data: {},
        previousHash: "0000",
      }),
    ).toThrow();
  });
});
