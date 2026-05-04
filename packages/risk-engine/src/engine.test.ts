import type { ReviewerVerdictSchema } from "@guardrails/schemas";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { describe, expect, it } from "vitest";
import type { RiskLimits } from "./config.js";
import { RiskEngine } from "./engine.js";
import type {
  DailyStats,
  MarketDataSnapshot,
  PortfolioSnapshot,
  RiskDataProvider,
} from "./providers.js";

const nowMs = Date.now();
const limits: RiskLimits = {
  maxMarketDataAgeMs: 10_000,
  maxPortfolioAgeMs: 30_000,
  maxNotionalUsd: 10,
  maxDailyNotionalUsd: 50,
  maxDailyLossUsd: 25,
  maxSlippageBps: 50,
  maxPositionDeltaPct: 10,
  minOrderIntervalMs: 5_000,
};

function makeVerdict(overrides?: Partial<ReviewerVerdictSchema>): ReviewerVerdictSchema {
  return {
    intentId: binanceSpotOrder.intentId,
    verdict: "approve",
    riskLevel: "low",
    reasons: ["OK"],
    detectedIssues: [],
    requiredPolicyTags: [],
    reviewerModel: "gpt-5.5",
    reviewerProvider: "openai",
    reviewedAt: new Date().toISOString(),
    ...overrides,
  };
}

const defaults = {
  marketData: (): MarketDataSnapshot => ({
    symbol: "ETH-USDC",
    price: 3500,
    timestampMs: nowMs - 1000,
  }),
  portfolio: (): PortfolioSnapshot => ({
    account: "subaccount-1",
    timestampMs: nowMs - 5000,
    positions: [{ symbol: "ETH-USDC", quantity: 1, notionalUsd: 3500 }],
  }),
  dailyStats: (): DailyStats => ({
    account: "subaccount-1",
    date: new Date().toISOString().slice(0, 10),
    totalNotionalUsd: 20,
    realizedLossUsd: 5,
    orderCount: 3,
  }),
  lastOrderTs: (): number => nowMs - 60_000,
};

function makeProvider(overrides?: {
  marketData?: MarketDataSnapshot | null;
  portfolio?: PortfolioSnapshot | null;
  dailyStats?: DailyStats | null;
  lastOrderTs?: number | null;
}): RiskDataProvider {
  function resolve<T>(key: keyof typeof defaults, fallback: () => T): T | null {
    if (overrides && key in overrides) {
      return overrides[key] as T | null;
    }
    return fallback();
  }
  return {
    async getMarketData() {
      return resolve("marketData", defaults.marketData);
    },
    async getPortfolio() {
      return resolve("portfolio", defaults.portfolio);
    },
    async getDailyStats() {
      return resolve("dailyStats", defaults.dailyStats);
    },
    async getLastOrderTimestampMs() {
      return resolve("lastOrderTs", defaults.lastOrderTs);
    },
  };
}

describe("RiskEngine", () => {
  it("passes all checks for valid low-risk order", async () => {
    const engine = new RiskEngine(makeProvider(), limits);
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(true);
    expect(result.checks.length).toBe(10);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("fails on stale market data", async () => {
    const engine = new RiskEngine(
      makeProvider({
        marketData: { symbol: "ETH-USDC", price: 3500, timestampMs: nowMs - 60_000 },
      }),
      limits,
    );
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "market_data_freshness");
    expect(check?.status).toBe("fail");
  });

  it("fails on missing market data (unavailable)", async () => {
    const engine = new RiskEngine(makeProvider({ marketData: null }), limits);
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "market_data_freshness");
    expect(check?.status).toBe("unavailable");
  });

  it("fails on stale portfolio data", async () => {
    const engine = new RiskEngine(
      makeProvider({
        portfolio: { account: "subaccount-1", timestampMs: nowMs - 120_000, positions: [] },
      }),
      limits,
    );
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "portfolio_freshness");
    expect(check?.status).toBe("fail");
  });

  it("fails on missing portfolio data", async () => {
    const engine = new RiskEngine(makeProvider({ portfolio: null }), limits);
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
  });

  it("fails when per-order notional exceeds limit", async () => {
    const engine = new RiskEngine(makeProvider(), { ...limits, maxNotionalUsd: 5 });
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "per_order_notional");
    expect(check?.status).toBe("fail");
  });

  it("fails when daily notional would be exceeded", async () => {
    const engine = new RiskEngine(
      makeProvider({
        dailyStats: {
          account: "subaccount-1",
          date: new Date().toISOString().slice(0, 10),
          totalNotionalUsd: 45,
          realizedLossUsd: 0,
          orderCount: 5,
        },
      }),
      limits,
    );
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "daily_notional");
    expect(check?.status).toBe("fail");
  });

  it("fails when daily loss exceeds limit", async () => {
    const engine = new RiskEngine(
      makeProvider({
        dailyStats: {
          account: "subaccount-1",
          date: new Date().toISOString().slice(0, 10),
          totalNotionalUsd: 10,
          realizedLossUsd: 30,
          orderCount: 5,
        },
      }),
      limits,
    );
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "daily_loss");
    expect(check?.status).toBe("fail");
  });

  it("fails when slippage exceeds limit", async () => {
    const engine = new RiskEngine(makeProvider(), { ...limits, maxSlippageBps: 10 });
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "slippage");
    expect(check?.status).toBe("fail");
  });

  it("fails on order frequency cooldown", async () => {
    const engine = new RiskEngine(makeProvider({ lastOrderTs: nowMs - 1000 }), limits);
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "order_frequency");
    expect(check?.status).toBe("fail");
  });

  it("fails when daily stats unavailable (fail-closed)", async () => {
    const engine = new RiskEngine(makeProvider({ dailyStats: null }), limits);
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const checkNotional = result.checks.find((c) => c.check === "daily_notional");
    const checkLoss = result.checks.find((c) => c.check === "daily_loss");
    expect(checkNotional?.status).toBe("unavailable");
    expect(checkLoss?.status).toBe("unavailable");
  });

  it("fails on reviewer verdict intentId mismatch", async () => {
    const engine = new RiskEngine(makeProvider(), limits);
    const badVerdict = makeVerdict({ intentId: "00000000-0000-0000-0000-000000000000" });
    const result = await engine.evaluate(binanceSpotOrder, badVerdict);
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "reviewer_consistency");
    expect(check?.status).toBe("fail");
  });

  it("fails when reviewer approved with detected issues", async () => {
    const engine = new RiskEngine(makeProvider(), limits);
    const badVerdict = makeVerdict({ detectedIssues: ["prompt_injection"] });
    const result = await engine.evaluate(binanceSpotOrder, badVerdict);
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "reviewer_consistency");
    expect(check?.status).toBe("fail");
  });
});
