import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BinanceAccountSnapshot } from "./interfaces.js";
import type {
  BinanceIncome,
  BinanceRiskHistory,
  BinanceRiskSource,
  BinanceTrade,
} from "./rest-types.js";
import { BinanceRiskDataProvider } from "./risk-provider.js";

const date = "2026-10-10";
const start = Date.parse(`${date}T00:00:00.000Z`);
const now = start + 12 * 60 * 60 * 1000;
const account = "dedicated";
const symbol = "ETH-USDC";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

function trade(id: string, overrides: Partial<BinanceTrade> = {}): BinanceTrade {
  return {
    id,
    orderId: id,
    symbol,
    side: "BUY",
    quantity: 1,
    quoteQuantity: 100,
    price: 100,
    commission: 0,
    commissionAsset: "USDC",
    timestampMs: start + 100,
    ...overrides,
  };
}
function snapshot(quantity = 0): BinanceAccountSnapshot {
  return {
    account,
    timestampMs: now,
    balances: [
      { asset: "USDC", free: 100, locked: 0 },
      { asset: "ETH", free: quantity, locked: 0 },
    ],
    positions: quantity ? [{ symbol, quantity, notionalUsd: quantity * 100, leverage: 1 }] : [],
  };
}
function history(overrides: Partial<BinanceRiskHistory> = {}): BinanceRiskHistory {
  return {
    account,
    date,
    timestampMs: now,
    trades: [],
    orders: [],
    income: [],
    lastOrderTimestampMs: null,
    ...overrides,
  };
}
function source(
  data = history(),
  portfolio = snapshot(),
  mode: "spot" | "usdm_futures" = "spot",
): BinanceRiskSource {
  return {
    account,
    accountMode: mode,
    historySymbols: [symbol],
    async getPrice() {
      return { symbol, price: 100, timestampMs: now };
    },
    async getAccountSnapshot() {
      return portfolio;
    },
    async getRiskHistory() {
      return data;
    },
  };
}
function income(id: string, incomeType: string, value: number, asset = "USDC"): BinanceIncome {
  return { id, incomeType, income: value, asset, timestampMs: start + 100 };
}

describe("Binance spot risk accounting", () => {
  it("reconstructs pre-day weighted cost, capitalizes buy fees, and counts unfilled orders once", async () => {
    const data = history({
      trades: [
        trade("1", { timestampMs: start - 1, quantity: 2, quoteQuantity: 200, commission: 2 }),
        trade("2", { side: "SELL", price: 80, quoteQuantity: 80, commission: 1 }),
        trade("3", {
          side: "SELL",
          price: 120,
          quoteQuantity: 120,
          commission: 1,
          timestampMs: start + 200,
        }),
      ],
      orders: [
        { symbol, orderId: "2", timestampMs: start + 100 },
        { symbol, orderId: "3", timestampMs: start + 200 },
        { symbol, orderId: "4", timestampMs: start + 300 },
        { symbol, orderId: "4", timestampMs: start + 300 },
      ],
      lastOrderTimestampMs: start + 300,
    });
    const provider = new BinanceRiskDataProvider(source(data));
    expect(await provider.getDailyStats(account, date)).toEqual({
      account,
      date,
      totalNotionalUsd: 200,
      realizedLossUsd: 22,
      orderCount: 3,
    });
    expect(await provider.getLastOrderTimestampMs(account)).toBe(start + 300);
  });

  it("accounts for base-asset commissions without inventing unowned inventory", async () => {
    const data = history({
      trades: [
        trade("1", {
          quantity: 2,
          quoteQuantity: 198,
          price: 99,
          timestampMs: start - 1,
          commission: 0.02,
          commissionAsset: "ETH",
        }),
        trade("2", {
          side: "SELL",
          quantity: 0.98,
          quoteQuantity: 88.2,
          price: 90,
          commission: 0.01,
          commissionAsset: "ETH",
        }),
      ],
    });
    const result = await new BinanceRiskDataProvider(source(data, snapshot(0.99))).getDailyStats(
      account,
      date,
    );
    expect(result.totalNotionalUsd).toBe(88.2);
    expect(result.realizedLossUsd).toBeCloseTo(10.8, 10);
  });

  it("includes locked spot inventory in reconciliation and returns the source valuation", async () => {
    const portfolio = snapshot(2);
    portfolio.balances[1].free = 1;
    portfolio.balances[1].locked = 1;
    portfolio.positions[0].notionalUsd = 250;
    const provider = new BinanceRiskDataProvider(
      source(history({ trades: [trade("1", { quantity: 2, quoteQuantity: 200 })] }), portfolio),
    );
    expect((await provider.getDailyStats(account, date)).totalNotionalUsd).toBe(200);
    expect((await provider.getPortfolio(account)).positions).toEqual([
      { symbol, quantity: 2, notionalUsd: 250 },
    ]);
  });

  it("fails closed for deposits with unknown basis, missing acquisitions and unsupported fee currencies", async () => {
    await expect(
      new BinanceRiskDataProvider(source(history(), snapshot(1))).getDailyStats(account, date),
    ).rejects.toThrow();
    await expect(
      new BinanceRiskDataProvider(
        source(history({ trades: [trade("1", { side: "SELL" })] })),
      ).getDailyStats(account, date),
    ).rejects.toThrow();
    await expect(
      new BinanceRiskDataProvider(
        source(
          history({ trades: [trade("1", { commission: 0.01, commissionAsset: "BNB" })] }),
          snapshot(1),
        ),
      ).getDailyStats(account, date),
    ).rejects.toThrow();
  });

  it("rejects incomplete portfolio coverage rather than assuming missing positions are zero", async () => {
    const portfolio = snapshot(1);
    portfolio.positions = [];
    await expect(
      new BinanceRiskDataProvider(source(history(), portfolio)).getPortfolio(account),
    ).rejects.toThrow();
  });
});

describe("Binance futures risk accounting", () => {
  it("sums executed notional, gross loss and fees without netting profits or duplicating commissions", async () => {
    const data = history({
      trades: [
        trade("1", { quantity: 0.1, quoteQuantity: 10, commission: 0.5 }),
        trade("2", { orderId: "1", quantity: 0.2, quoteQuantity: 20, commission: 0.5 }),
      ],
      orders: [
        { symbol, orderId: "1", timestampMs: start + 1 },
        { symbol, orderId: "2", timestampMs: start + 2 },
      ],
      income: [
        income("1", "REALIZED_PNL", -12),
        income("2", "COMMISSION", -1),
        income("3", "FUNDING_FEE", -2),
        income("4", "REALIZED_PNL", 30),
        income("5", "INSURANCE_CLEAR", -3),
        income("6", "TRANSFER", -100),
      ],
      lastOrderTimestampMs: start + 2,
    });
    const provider = new BinanceRiskDataProvider(
      source(
        data,
        {
          account,
          timestampMs: now,
          balances: [{ asset: "USDC", free: 110, locked: -10 }],
          positions: [{ symbol, quantity: -2, notionalUsd: -230, leverage: 2 }],
        },
        "usdm_futures",
      ),
    );
    expect(await provider.getDailyStats(account, date)).toEqual({
      account,
      date,
      totalNotionalUsd: 30,
      realizedLossUsd: 18,
      orderCount: 2,
    });
    expect((await provider.getPortfolio(account)).positions).toEqual([
      { symbol, quantity: -2, notionalUsd: -230 },
    ]);
  });

  it("does not treat income with unknown USD value as zero loss", async () => {
    const data = history({ income: [income("1", "COMMISSION", -1, "BNB")] });
    await expect(
      new BinanceRiskDataProvider(source(data, snapshot(), "usdm_futures")).getDailyStats(
        account,
        date,
      ),
    ).rejects.toThrow();
  });

  it("does not classify prototype names as transfers or USD-valued assets", async () => {
    const data = history({ income: [income("1", "constructor", -50)] });
    const provider = new BinanceRiskDataProvider(source(data, snapshot(), "usdm_futures"));
    expect((await provider.getDailyStats(account, date)).realizedLossUsd).toBe(50);
    const invalidAsset = history({ income: [income("1", "COMMISSION", -50, "__proto__")] });
    await expect(
      new BinanceRiskDataProvider(source(invalidAsset, snapshot(), "usdm_futures")).getDailyStats(
        account,
        date,
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate fills and income rather than distorting daily budgets", async () => {
    for (const data of [
      history({ trades: [trade("1"), trade("1")] }),
      history({ income: [income("1", "REALIZED_PNL", -10), income("1", "REALIZED_PNL", -10)] }),
    ]) {
      await expect(
        new BinanceRiskDataProvider(source(data, snapshot(), "usdm_futures")).getDailyStats(
          account,
          date,
        ),
      ).rejects.toThrow();
    }
  });
});

describe("Binance risk data availability", () => {
  it("returns zero only after complete successful empty history and refuses source outages", async () => {
    const provider = new BinanceRiskDataProvider(source());
    expect(await provider.getDailyStats(account, date)).toEqual({
      account,
      date,
      totalNotionalUsd: 0,
      realizedLossUsd: 0,
      orderCount: 0,
    });
    expect(await provider.getLastOrderTimestampMs(account)).toBeNull();
    const unavailable = new BinanceRiskDataProvider({
      ...source(),
      async getRiskHistory() {
        throw new Error("Exchange unavailable.");
      },
    });
    await expect(unavailable.getDailyStats(account, date)).rejects.toThrow();
    await expect(unavailable.getLastOrderTimestampMs(account)).rejects.toThrow();
  });

  it("does not accept stale, future, account-rebound or day-rebound facts", async () => {
    for (const data of [
      history({ timestampMs: now - 30_001 }),
      history({ timestampMs: now + 1 }),
      history({ account: "another-account" }),
      history({ date: "2026-10-09" }),
    ]) {
      await expect(
        new BinanceRiskDataProvider(source(data)).getDailyStats(account, date),
      ).rejects.toThrow();
    }
    const provider = new BinanceRiskDataProvider(source());
    await expect(provider.getDailyStats("another-account", date)).rejects.toThrow();
    await provider.getDailyStats(account, date);
    vi.setSystemTime(now + 86_400_000);
    await expect(provider.getDailyStats(account, date)).rejects.toThrow();
  });

  it("new evaluations observe new losses while an old evaluation cannot reuse expired data", async () => {
    const data = history();
    const backend = source(data, snapshot(), "usdm_futures");
    const old = new BinanceRiskDataProvider(backend);
    expect((await old.getDailyStats(account, date)).realizedLossUsd).toBe(0);
    data.income.push(income("1", "REALIZED_PNL", -30));
    expect(
      (await new BinanceRiskDataProvider(backend).getDailyStats(account, date)).realizedLossUsd,
    ).toBe(30);
    vi.setSystemTime(now + 30_001);
    await expect(old.getDailyStats(account, date)).rejects.toThrow();
  });
});
