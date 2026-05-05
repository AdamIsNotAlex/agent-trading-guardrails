import type { ReviewerVerdictSchema } from "@guardrails/schemas";
import { binanceOrderStatus, binanceSpotOrder } from "@guardrails/schemas/fixtures";
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
  maxPriceBandBps: 100,
  maxPositionDeltaPct: 10,
  minOrderIntervalMs: 5_000,
  maxOrdersPerDay: 25,
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
    expect(result.checks.length).toBe(12);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
    expect(result.dailyStats).toEqual(defaults.dailyStats());
  });

  it("reads market data once for priced orders", async () => {
    let marketDataCalls = 0;
    const provider = makeProvider();
    const engine = new RiskEngine(
      {
        ...provider,
        async getMarketData(symbol) {
          marketDataCalls += 1;
          return provider.getMarketData(symbol);
        },
      },
      limits,
    );

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());

    expect(result.passed).toBe(true);
    expect(marketDataCalls).toBe(1);
  });

  it("accepts market data stamped during provider read", async () => {
    const provider = makeProvider();
    const engine = new RiskEngine(
      {
        ...provider,
        async getMarketData() {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return { symbol: "ETH-USDC", price: 3500, timestampMs: Date.now() };
        },
      },
      limits,
    );

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());

    expect(result.passed).toBe(true);
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
    const priceBand = result.checks.find((c) => c.check === "price_band");
    expect(check?.status).toBe("fail");
    expect(priceBand?.status).toBe("unavailable");
  });

  it("fails on missing market data (unavailable)", async () => {
    const engine = new RiskEngine(makeProvider({ marketData: null }), limits);
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "market_data_freshness");
    expect(check?.status).toBe("unavailable");
  });

  it("fails closed when market data timestamp is invalid", async () => {
    const engine = new RiskEngine(
      makeProvider({
        marketData: { symbol: "ETH-USDC", price: 3500, timestampMs: Number.NaN },
      }),
      limits,
    );
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const freshness = result.checks.find((c) => c.check === "market_data_freshness");
    const priceBand = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(false);
    expect(freshness?.status).toBe("unavailable");
    expect(priceBand?.status).toBe("unavailable");
  });

  it("fails closed when market data timestamp is in the future", async () => {
    const engine = new RiskEngine(
      makeProvider({
        marketData: { symbol: "ETH-USDC", price: 3500, timestampMs: Date.now() + 60_000 },
      }),
      limits,
    );
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const freshness = result.checks.find((c) => c.check === "market_data_freshness");
    const priceBand = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(false);
    expect(freshness?.status).toBe("unavailable");
    expect(priceBand?.status).toBe("unavailable");
  });

  it("fails closed when market data is from a different symbol", async () => {
    const engine = new RiskEngine(
      makeProvider({
        marketData: { symbol: "BTC-USDC", price: 3500, timestampMs: nowMs - 1000 },
      }),
      limits,
    );
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const freshness = result.checks.find((c) => c.check === "market_data_freshness");
    const priceBand = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(false);
    expect(freshness?.status).toBe("unavailable");
    expect(priceBand?.status).toBe("unavailable");
  });

  it("does not require trading risk state for order status queries", async () => {
    let marketDataCalls = 0;
    let dailyStatsCalls = 0;
    const provider = makeProvider({
      marketData: null,
      portfolio: null,
      dailyStats: null,
      lastOrderTs: nowMs - 1000,
    });
    const engine = new RiskEngine(
      {
        ...provider,
        async getMarketData() {
          marketDataCalls += 1;
          throw new Error("market data should not be read for order status queries");
        },
        async getDailyStats() {
          dailyStatsCalls += 1;
          throw new Error("daily stats should not be read for order status queries");
        },
      },
      limits,
    );
    const result = await engine.evaluate(
      binanceOrderStatus,
      makeVerdict({
        intentId: binanceOrderStatus.intentId,
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.dailyStats).toBeUndefined();
    expect(result.checks.find((c) => c.check === "market_data_freshness")?.status).toBe("pass");
    expect(result.checks.find((c) => c.check === "price_band")?.status).toBe("pass");
    expect(result.checks.find((c) => c.check === "portfolio_freshness")?.status).toBe("pass");
    expect(result.checks.find((c) => c.check === "daily_loss")?.status).toBe("pass");
    expect(result.checks.find((c) => c.check === "order_frequency")?.status).toBe("pass");
    expect(result.checks.find((c) => c.check === "daily_order_count")?.status).toBe("pass");
    expect(marketDataCalls).toBe(0);
    expect(dailyStatsCalls).toBe(0);
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

  it("passes when order price is within market price band", async () => {
    const engine = new RiskEngine(
      makeProvider({
        marketData: { symbol: "ETH-USDC", price: 3470, timestampMs: nowMs - 1000 },
      }),
      limits,
    );

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const check = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(true);
    expect(check).toMatchObject({
      status: "pass",
      threshold: limits.maxPriceBandBps,
    });
  });

  it("passes when order price is exactly at the market price band limit", async () => {
    const orderPrice = binanceSpotOrder.price;
    expect(orderPrice).toBeDefined();
    if (orderPrice === undefined) {
      throw new Error("Fixture order price is required for price-band boundary test.");
    }
    const marketPrice = orderPrice / (1 + limits.maxPriceBandBps / 10_000);
    const engine = new RiskEngine(
      makeProvider({
        marketData: { symbol: "ETH-USDC", price: marketPrice, timestampMs: nowMs - 1000 },
      }),
      limits,
    );

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const check = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(true);
    expect(check).toMatchObject({
      status: "pass",
      threshold: limits.maxPriceBandBps,
    });
    expect(check?.value).toBeCloseTo(limits.maxPriceBandBps);
  });

  it("fails when order price is above market price band", async () => {
    const engine = new RiskEngine(
      makeProvider({
        marketData: { symbol: "ETH-USDC", price: 3000, timestampMs: nowMs - 1000 },
      }),
      limits,
    );

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const check = result.checks.find((c) => c.check === "price_band");
    const failedChecks = result.checks.filter((c) => c.status !== "pass");

    expect(result.passed).toBe(false);
    expect(failedChecks.map((c) => c.check)).toEqual(["price_band"]);
    expect(check).toMatchObject({
      status: "fail",
      threshold: limits.maxPriceBandBps,
    });
  });

  it("fails when order price is below market price band", async () => {
    const engine = new RiskEngine(makeProvider(), limits);

    const result = await engine.evaluate({ ...binanceSpotOrder, price: 3000 }, makeVerdict());
    const check = result.checks.find((c) => c.check === "price_band");
    const failedChecks = result.checks.filter((c) => c.status !== "pass");

    expect(result.passed).toBe(false);
    expect(failedChecks.map((c) => c.check)).toEqual(["price_band"]);
    expect(check).toMatchObject({
      status: "fail",
      threshold: limits.maxPriceBandBps,
    });
  });

  it("fails closed for price band when market data is missing", async () => {
    const engine = new RiskEngine(makeProvider({ marketData: null }), limits);

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const freshness = result.checks.find((c) => c.check === "market_data_freshness");
    const priceBand = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(false);
    expect(freshness?.status).toBe("unavailable");
    expect(priceBand?.status).toBe("unavailable");
  });

  it("fails closed for price band when market price is not positive", async () => {
    const engine = new RiskEngine(
      makeProvider({
        marketData: { symbol: "ETH-USDC", price: 0, timestampMs: nowMs - 1000 },
      }),
      limits,
    );

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const priceBand = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(false);
    expect(priceBand?.status).toBe("unavailable");
  });

  it("fails closed for price band when market price is not finite", async () => {
    const engine = new RiskEngine(
      makeProvider({
        marketData: {
          symbol: "ETH-USDC",
          price: Number.POSITIVE_INFINITY,
          timestampMs: nowMs - 1000,
        },
      }),
      limits,
    );

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const priceBand = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(false);
    expect(priceBand?.status).toBe("unavailable");
  });

  it.each([
    null,
    undefined,
    Number.NaN,
    0,
    -1,
  ])("fails closed for price band when intent price is invalid (%s)", async (price) => {
    const engine = new RiskEngine(makeProvider(), limits);
    const intent = { ...binanceSpotOrder, price } as unknown as typeof binanceSpotOrder;

    const result = await engine.evaluate(intent, makeVerdict());
    const priceBand = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(false);
    expect(priceBand).toMatchObject({
      status: "unavailable",
      message: "Intent price unavailable or invalid.",
    });
  });

  it("fails closed for price band when intent price is omitted", async () => {
    const engine = new RiskEngine(makeProvider(), limits);
    const intent = { ...binanceSpotOrder };
    delete intent.price;

    const result = await engine.evaluate(intent, makeVerdict());
    const priceBand = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(false);
    expect(priceBand).toMatchObject({
      status: "unavailable",
      message: "Intent price unavailable or invalid.",
    });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
  ])("fails closed when the market data age limit is invalid (%s)", async (maxMarketDataAgeMs) => {
    const engine = new RiskEngine(makeProvider(), { ...limits, maxMarketDataAgeMs });

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const freshness = result.checks.find((c) => c.check === "market_data_freshness");
    const priceBand = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(false);
    expect(freshness?.status).toBe("unavailable");
    expect(priceBand?.status).toBe("unavailable");
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
  ])("fails closed for price band when the limit is invalid (%s)", async (maxPriceBandBps) => {
    const engine = new RiskEngine(makeProvider(), { ...limits, maxPriceBandBps });

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const priceBand = result.checks.find((c) => c.check === "price_band");

    expect(result.passed).toBe(false);
    expect(priceBand?.status).toBe("unavailable");
  });

  it("fails when position delta exceeds limit", async () => {
    const engine = new RiskEngine(
      makeProvider({
        portfolio: {
          account: "subaccount-1",
          timestampMs: nowMs - 5000,
          positions: [{ symbol: "ETH-USDC", quantity: 0.01, notionalUsd: 50 }],
        },
      }),
      limits,
    );

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const check = result.checks.find((c) => c.check === "position_delta");

    expect(result.passed).toBe(false);
    expect(check).toMatchObject({
      status: "fail",
      value: 20,
      threshold: limits.maxPositionDeltaPct,
    });
  });

  it("fails on order frequency cooldown", async () => {
    const engine = new RiskEngine(makeProvider({ lastOrderTs: nowMs - 1000 }), limits);
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.check === "order_frequency");
    expect(check?.status).toBe("fail");
  });

  it("passes when projected daily order count is within limit", async () => {
    const engine = new RiskEngine(
      makeProvider({
        dailyStats: {
          account: "subaccount-1",
          date: new Date().toISOString().slice(0, 10),
          totalNotionalUsd: 20,
          realizedLossUsd: 5,
          orderCount: 24,
        },
      }),
      limits,
    );

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const check = result.checks.find((c) => c.check === "daily_order_count");

    expect(result.passed).toBe(true);
    expect(check).toMatchObject({
      status: "pass",
      value: limits.maxOrdersPerDay,
      threshold: limits.maxOrdersPerDay,
    });
  });

  it("fails when projected daily order count exceeds limit", async () => {
    const engine = new RiskEngine(
      makeProvider({
        dailyStats: {
          account: "subaccount-1",
          date: new Date().toISOString().slice(0, 10),
          totalNotionalUsd: 20,
          realizedLossUsd: 5,
          orderCount: 25,
        },
      }),
      limits,
    );

    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    const check = result.checks.find((c) => c.check === "daily_order_count");
    const failedChecks = result.checks.filter((c) => c.status !== "pass");

    expect(result.passed).toBe(false);
    expect(failedChecks.map((c) => c.check)).toEqual(["daily_order_count"]);
    expect(check).toMatchObject({
      status: "fail",
      value: limits.maxOrdersPerDay + 1,
      threshold: limits.maxOrdersPerDay,
    });
  });

  it("fails when daily stats unavailable (fail-closed)", async () => {
    const engine = new RiskEngine(makeProvider({ dailyStats: null }), limits);
    const result = await engine.evaluate(binanceSpotOrder, makeVerdict());
    expect(result.passed).toBe(false);
    const checkNotional = result.checks.find((c) => c.check === "daily_notional");
    const checkLoss = result.checks.find((c) => c.check === "daily_loss");
    const checkOrderCount = result.checks.find((c) => c.check === "daily_order_count");
    expect(checkNotional?.status).toBe("unavailable");
    expect(checkLoss?.status).toBe("unavailable");
    expect(checkOrderCount?.status).toBe("unavailable");
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
