import { ConnectorRevalidationError } from "@guardrails/broker";
import {
  binanceCancelOrder,
  binanceFuturesOrder,
  binanceOrderStatus,
  binanceSpotOrder,
} from "@guardrails/schemas/fixtures";
import { describe, expect, it } from "vitest";
import { BinanceConnector } from "./connector.js";
import type { BinanceApiClient, BinanceApiKeyPermissions, BinanceConfig } from "./interfaces.js";
import { ORDER_STATUS_LOOKUP_FAILED } from "./reconciliation.js";

const config: BinanceConfig = {
  apiKey: "test-key",
  apiSecret: "test-secret",
  testnet: true,
  accountMode: "spot",
  allowedAccounts: ["subaccount-1", "subaccount-2"],
  allowedSpotSymbols: ["ETH-USDC", "BTC-USDC"],
  allowedFuturesSymbols: [],
  historySymbols: ["ETH-USDC", "BTC-USDC"],
  maxFuturesLeverage: 3,
  ipAllowlist: [],
};
const futuresConfig: BinanceConfig = {
  ...config,
  accountMode: "usdm_futures",
  allowedSpotSymbols: [],
  allowedFuturesSymbols: ["BTC-USDT", "ETH-USDT"],
  historySymbols: ["BTC-USDT", "ETH-USDT"],
};
const liveMainnetConfig: BinanceConfig = {
  ...config,
  testnet: false,
  ipAllowlist: ["203.0.113.10"],
};
const liveMainnetFuturesConfig: BinanceConfig = {
  ...futuresConfig,
  testnet: false,
  ipAllowlist: ["203.0.113.10"],
};
const safePermissions: BinanceApiKeyPermissions = {
  ipRestrict: true,
  enableWithdrawals: false,
  enableReading: true,
  enableSpotAndMarginTrading: true,
  enableFutures: true,
};

function makeMockClient(): BinanceApiClient {
  let lastPlaced:
    | {
        orderId: string;
        symbol: string;
        side: string;
        status: string;
        executedQty: number;
        avgPrice: number;
      }
    | undefined;
  return {
    async getPrice(symbol) {
      return { symbol, price: 3500, timestampMs: Date.now() };
    },
    async getAccountSnapshot(account) {
      return { account, balances: [], positions: [], timestampMs: Date.now() };
    },
    async placeSpotOrder(params) {
      lastPlaced = {
        orderId: "live-spot-001",
        symbol: params.symbol,
        side: params.side,
        status: "FILLED",
        executedQty: params.quantity ?? 0.002,
        avgPrice: params.price ?? 3500,
      };
      return lastPlaced;
    },
    async getFuturesMarginType() {
      return "isolated";
    },
    async placeFuturesOrder(params) {
      lastPlaced = {
        orderId: "live-futures-001",
        symbol: params.symbol,
        side: params.side,
        status: "FILLED",
        executedQty: params.quantity ?? 0.00004,
        avgPrice: params.price ?? 100000,
      };
      return lastPlaced;
    },
    async cancelOrder(params) {
      return {
        orderId: params.orderId,
        symbol: params.symbol,
        side: "BUY",
        status: "CANCELED",
        executedQty: 0,
        avgPrice: 0,
      };
    },
    async getOrderStatus(params) {
      if (lastPlaced && lastPlaced.orderId === params.orderId) {
        return { ...lastPlaced };
      }
      return {
        orderId: params.orderId,
        symbol: params.symbol,
        side: "BUY",
        status: "FILLED",
        executedQty: 0.002,
        avgPrice: 3500,
      };
    },
    async getApiKeyPermissions() {
      return { ...safePermissions };
    },
  };
}

describe("BinanceConnector (paper mode)", () => {
  it("executes spot paper order", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const result = await connector.execute(binanceSpotOrder);
    expect(result.orderId).toBeTruthy();
    expect(result.orderId).toContain("paper-spot");
  });

  it("executes futures paper order", async () => {
    const connector = new BinanceConnector(futuresConfig, null, "paper");
    const result = await connector.execute(binanceFuturesOrder);
    expect(result.orderId).toBeTruthy();
    expect(result.orderId).toContain("paper-futures");
  });

  it("executes cancel paper order", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const result = await connector.execute(binanceCancelOrder);
    expect(result.orderId).toBeTruthy();
  });

  it("rejects paper cancel account mismatch", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const placed = await connector.execute(binanceSpotOrder);

    await expect(
      connector.execute({
        ...binanceCancelOrder,
        account: "subaccount-2",
        orderId: placed.orderId ?? "",
      }),
    ).rejects.toThrow("account and symbol");
  });

  it("gets paper order status", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const placed = await connector.execute(binanceSpotOrder);
    const result = await connector.getOrderStatus({
      account: binanceOrderStatus.account,
      symbol: binanceOrderStatus.symbol,
      orderId: placed.orderId ?? "",
    });

    expect(result.orderId).toBe(placed.orderId);
    expect(result.status).toBe("FILLED");
  });

  it("rejects paper order status symbol mismatch", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const placed = await connector.execute(binanceSpotOrder);

    await expect(
      connector.getOrderStatus({
        account: binanceOrderStatus.account,
        symbol: "BTC-USDC",
        orderId: placed.orderId ?? "",
      }),
    ).rejects.toThrow("symbol BTC-USDC");
  });

  it("rejects paper order status account mismatch", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const placed = await connector.execute(binanceSpotOrder);

    await expect(
      connector.getOrderStatus({
        account: "subaccount-2",
        symbol: binanceOrderStatus.symbol,
        orderId: placed.orderId ?? "",
      }),
    ).rejects.toThrow("account subaccount-2");
  });

  it("executes order status query", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const placed = await connector.execute(binanceSpotOrder);
    const result = await connector.execute({
      ...binanceOrderStatus,
      orderId: placed.orderId ?? "",
    });

    expect(result.orderId).toBe(placed.orderId);
    expect(result.orderStatus).toMatchObject({ orderId: placed.orderId, status: "FILLED" });
  });

  it("revalidates successfully in paper mode", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const result = await connector.revalidate(binanceSpotOrder);
    expect(result.passed).toBe(true);
  });
});

describe("BinanceConnector (live mode with mock)", () => {
  it("executes spot live order via mock client", async () => {
    const connector = new BinanceConnector(config, makeMockClient(), "live");
    const result = await connector.execute(binanceSpotOrder);
    expect(result.orderId).toBe("live-spot-001");
    expect(result.orderStatus).toMatchObject({
      orderId: "live-spot-001",
      status: "FILLED",
      executedQty: 0.002,
      avgPrice: 3500,
    });
    expect(result.reconciliation?.status).toBe("matched");
  });

  it("passes stable client order ids for live spot orders", async () => {
    const seenClientOrderIds: string[] = [];
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async placeSpotOrder(params) {
        seenClientOrderIds.push(params.clientOrderId ?? "");
        return makeMockClient().placeSpotOrder(params);
      },
    };
    const connector = new BinanceConnector(config, client, "live");

    await connector.execute(binanceSpotOrder);
    await connector.execute(binanceSpotOrder);

    expect(seenClientOrderIds).toHaveLength(2);
    expect(seenClientOrderIds[0]).toMatch(/^guardrails-[0-9a-f]{24}$/);
    expect(seenClientOrderIds[1]).toBe(seenClientOrderIds[0]);
  });

  it("passes stable client order ids for live futures orders", async () => {
    const seenClientOrderIds: string[] = [];
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getPrice(symbol) {
        return { symbol, price: binanceFuturesOrder.price, timestampMs: Date.now() };
      },
      async placeFuturesOrder(params) {
        seenClientOrderIds.push(params.clientOrderId ?? "");
        return makeMockClient().placeFuturesOrder(params);
      },
    };
    const connector = new BinanceConnector(futuresConfig, client, "live");

    await connector.execute(binanceFuturesOrder);
    await connector.execute(binanceFuturesOrder);

    expect(seenClientOrderIds).toHaveLength(2);
    expect(seenClientOrderIds[0]).toMatch(/^guardrails-[0-9a-f]{24}$/);
    expect(seenClientOrderIds[1]).toBe(seenClientOrderIds[0]);
  });

  it("gets live order status via mock client", async () => {
    const connector = new BinanceConnector(config, makeMockClient(), "live");
    const result = await connector.getOrderStatus({
      account: binanceOrderStatus.account,
      symbol: binanceOrderStatus.symbol,
      orderId: binanceOrderStatus.orderId,
    });

    expect(result).toMatchObject({
      orderId: binanceOrderStatus.orderId,
      symbol: binanceOrderStatus.symbol,
      status: "FILLED",
    });
  });

  it("executes order status query via mock client", async () => {
    const connector = new BinanceConnector(config, makeMockClient(), "live");
    const result = await connector.execute(binanceOrderStatus);

    expect(result.orderId).toBe(binanceOrderStatus.orderId);
    expect(result.orderStatus).toMatchObject({
      orderId: binanceOrderStatus.orderId,
      status: "FILLED",
      executedQty: 0.002,
      avgPrice: 3500,
    });
  });

  it("revalidates with live market data", async () => {
    const connector = new BinanceConnector(config, makeMockClient(), "live");
    const result = await connector.revalidate(binanceSpotOrder);
    expect(result.passed).toBe(true);
  });

  const rejectedMarketDataCases: Array<{
    name: string;
    price: number;
    timestampMs: () => number;
    reason: string;
  }> = [
    {
      name: "stale market timestamp",
      price: binanceSpotOrder.price,
      timestampMs: () => Date.now() - 11_000,
      reason: "Market data is",
    },
    {
      name: "future market timestamp",
      price: binanceSpotOrder.price,
      timestampMs: () => Date.now() + 1_000,
      reason: "Market data timestamp is invalid.",
    },
    {
      name: "NaN timestamp",
      price: binanceSpotOrder.price,
      timestampMs: () => Number.NaN,
      reason: "Market data timestamp is invalid.",
    },
    {
      name: "zero price",
      price: 0,
      timestampMs: () => Date.now(),
      reason: "Market data price is invalid.",
    },
    {
      name: "negative price",
      price: -1,
      timestampMs: () => Date.now(),
      reason: "Market data price is invalid.",
    },
    {
      name: "NaN price",
      price: Number.NaN,
      timestampMs: () => Date.now(),
      reason: "Market data price is invalid.",
    },
  ];

  for (const testCase of rejectedMarketDataCases) {
    it(`rejects live revalidation with ${testCase.name}`, async () => {
      const client: BinanceApiClient = {
        ...makeMockClient(),
        async getPrice(symbol) {
          return { symbol, price: testCase.price, timestampMs: testCase.timestampMs() };
        },
      };
      const connector = new BinanceConnector(config, client, "live");

      const result = await connector.revalidate(binanceSpotOrder);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain(testCase.reason);
    });
  }

  it("rejects live revalidation when price deviation exceeds approved slippage", async () => {
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getPrice(symbol) {
        return { symbol, price: binanceSpotOrder.price * 2, timestampMs: Date.now() };
      },
    };
    const connector = new BinanceConnector(config, client, "live");

    const result = await connector.revalidate(binanceSpotOrder);

    expect(result.passed).toBe(false);
    expect(result.reason).toContain("exceeds approved slippage");
  });

  it("rejects live revalidation when executable notional exceeds approved max", async () => {
    const connector = new BinanceConnector(config, makeMockClient(), "live");

    const result = await connector.revalidate({ ...binanceSpotOrder, maxNotionalUsd: 1 });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("Executable order notional exceeds approved maxNotionalUsd.");
  });

  it("rejects live revalidation when market data fetch fails", async () => {
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getPrice() {
        throw new Error("price feed unavailable");
      },
    };
    const connector = new BinanceConnector(config, client, "live");

    const result = await connector.revalidate(binanceSpotOrder);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("Failed to fetch market data for revalidation.");
  });

  it("does not fetch live market data when revalidating order status", async () => {
    let getPriceCalls = 0;
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getPrice(symbol) {
        getPriceCalls += 1;
        return makeMockClient().getPrice(symbol);
      },
    };
    const connector = new BinanceConnector(config, client, "live");
    const result = await connector.revalidate(binanceOrderStatus);
    expect(result.passed).toBe(true);
    expect(getPriceCalls).toBe(0);
  });

  it("fails order status revalidation when client is missing in live mode", async () => {
    const connector = new BinanceConnector(config, null, "live");
    const result = await connector.revalidate(binanceOrderStatus);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("not configured");
  });

  it("fails revalidation when client is missing in live mode", async () => {
    const connector = new BinanceConnector(config, null, "live");
    const result = await connector.revalidate(binanceSpotOrder);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("not configured");
  });
});

describe("BinanceConnector validation", () => {
  it.each([
    "spot",
    "usdm_futures",
  ] as const)("rejects new orders for the other product even when its symbol is enabled for %s", async (accountMode) => {
    const connector = new BinanceConnector(
      {
        ...config,
        accountMode,
        allowedSpotSymbols: ["ETH-USDC"],
        allowedFuturesSymbols: ["ETH-USDC"],
      },
      makeMockClient(),
      "live",
    );
    const intent = {
      ...(accountMode === "spot" ? binanceFuturesOrder : binanceSpotOrder),
      symbol: "ETH-USDC",
    };
    expect((await connector.revalidate(intent)).passed).toBe(false);
    await expect(connector.execute(intent)).rejects.toThrow(ConnectorRevalidationError);
  });

  it("rejects disallowed account", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const intent = { ...binanceSpotOrder, account: "unknown-account" };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("allowlist");
  });

  it("rejects disallowed spot symbol", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const intent = { ...binanceSpotOrder, symbol: "DOGE-USDT" };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("allowlist");
  });

  it("rejects disallowed order status symbol", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const result = await connector.revalidate({ ...binanceOrderStatus, symbol: "DOGE-USDT" });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("allowlist");
  });

  it("rejects disallowed cancel symbol", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const result = await connector.revalidate({ ...binanceCancelOrder, symbol: "DOGE-USDT" });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("allowlist");
  });

  it("rejects margin account mode", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const intent = { ...binanceSpotOrder, accountMode: "margin" as "spot" };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("margin");
  });

  it("rejects cross-margin account mode", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const intent = { ...binanceSpotOrder, accountMode: "cross_margin" as "spot" };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
  });

  it("rejects COIN-M futures account mode", async () => {
    const connector = new BinanceConnector(config, null, "paper");
    const intent = { ...binanceSpotOrder, accountMode: "coinm_futures" as "spot" };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("COIN-M");
  });

  it("rejects futures leverage above cap", async () => {
    const connector = new BinanceConnector(futuresConfig, null, "paper");
    const intent = { ...binanceFuturesOrder, leverage: 10 };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Leverage");
  });

  it("rejects cross-margin futures", async () => {
    const connector = new BinanceConnector(futuresConfig, null, "paper");
    const intent = { ...binanceFuturesOrder, marginType: "cross" as const };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("isolated margin");
  });

  it("rejects futures orders without margin type", async () => {
    const connector = new BinanceConnector(futuresConfig, null, "paper");
    const { marginType: _marginType, ...intent } = binanceFuturesOrder;
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("isolated margin");
  });

  it("rejects direct cross-margin futures execution", async () => {
    const connector = new BinanceConnector(futuresConfig, null, "paper");
    await expect(
      connector.execute({ ...binanceFuturesOrder, marginType: "cross" }),
    ).rejects.toThrow("isolated margin");
  });

  it("rejects live futures execution when exchange margin mode is cross", async () => {
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getFuturesMarginType() {
        return "cross";
      },
    };
    const connector = new BinanceConnector(futuresConfig, client, "live");

    await expect(connector.execute(binanceFuturesOrder)).rejects.toThrow("isolated margin");
  });

  it("fails live futures revalidation when exchange margin mode is cross", async () => {
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getFuturesMarginType() {
        return "cross";
      },
    };
    const connector = new BinanceConnector(futuresConfig, client, "live");
    const result = await connector.revalidate(binanceFuturesOrder);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("isolated margin");
  });

  it("gets market data through broker only", async () => {
    const connector = new BinanceConnector(config, makeMockClient(), "live");
    const data = await connector.getMarketData("ETH-USDC");
    expect(data.symbol).toBe("ETH-USDC");
    expect(data.price).toBe(3500);
  });

  it("gets account snapshot through broker only", async () => {
    const connector = new BinanceConnector(config, makeMockClient(), "live");
    const snapshot = await connector.getAccountSnapshot("subaccount-1");
    expect(snapshot.account).toBe("subaccount-1");
  });
});

describe("BinanceConnector live mainnet permissions and reconciliation", () => {
  it("rejects empty or wildcard IP allowlists before live mainnet construction", () => {
    expect(
      () =>
        new BinanceConnector(
          { ...config, testnet: false, ipAllowlist: [] },
          makeMockClient(),
          "live",
        ),
    ).toThrow();
    expect(
      () =>
        new BinanceConnector(
          { ...config, testnet: false, ipAllowlist: ["0.0.0.0"] },
          makeMockClient(),
          "live",
        ),
    ).toThrow();
  });

  it("does not fetch market data or place orders when the live key is unsafe", async () => {
    let priceCalls = 0;
    let placeCalls = 0;
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getApiKeyPermissions() {
        return { ...safePermissions, enableWithdrawals: true };
      },
      async getPrice(symbol) {
        priceCalls += 1;
        return { symbol, price: 3500, timestampMs: Date.now() };
      },
      async placeSpotOrder(params) {
        placeCalls += 1;
        return {
          orderId: "should-not-place",
          symbol: params.symbol,
          side: params.side,
          status: "NEW",
          executedQty: 0,
          avgPrice: 0,
        };
      },
    };
    const connector = new BinanceConnector(liveMainnetConfig, client, "live");
    const result = await connector.revalidate(binanceSpotOrder);
    expect(result.passed).toBe(false);
    await expect(connector.execute(binanceSpotOrder)).rejects.toThrow(ConnectorRevalidationError);
    expect(priceCalls).toBe(0);
    expect(placeCalls).toBe(0);
  });

  it("rejects unrestricted or unread live keys before side effects", async () => {
    for (const permissions of [
      { ...safePermissions, ipRestrict: false },
      { ...safePermissions, enableReading: false },
      { ...safePermissions, enableSpotAndMarginTrading: false },
    ]) {
      let placeCalls = 0;
      const client: BinanceApiClient = {
        ...makeMockClient(),
        async getApiKeyPermissions() {
          return permissions;
        },
        async placeSpotOrder(params) {
          placeCalls += 1;
          return makeMockClient().placeSpotOrder(params);
        },
      };
      const connector = new BinanceConnector(liveMainnetConfig, client, "live");
      const result = await connector.revalidate(binanceSpotOrder);
      expect(result.passed).toBe(false);
      await expect(connector.execute(binanceSpotOrder)).rejects.toThrow(ConnectorRevalidationError);
      expect(placeCalls).toBe(0);
    }
  });

  it("rejects missing futures trading permission without placing an order", async () => {
    let placeCalls = 0;
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getPrice(symbol) {
        return { symbol, price: binanceFuturesOrder.price, timestampMs: Date.now() };
      },
      async getApiKeyPermissions() {
        return { ...safePermissions, enableFutures: false };
      },
      async placeFuturesOrder(params) {
        placeCalls += 1;
        return makeMockClient().placeFuturesOrder(params);
      },
    };
    const connector = new BinanceConnector(liveMainnetFuturesConfig, client, "live");
    const result = await connector.revalidate(binanceFuturesOrder);
    expect(result.passed).toBe(false);
    await expect(connector.execute(binanceFuturesOrder)).rejects.toThrow(
      ConnectorRevalidationError,
    );
    expect(placeCalls).toBe(0);
  });

  it("redacts permission lookup failures and skips market data", async () => {
    let priceCalls = 0;
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getApiKeyPermissions() {
        throw new Error(`secret ${config.apiSecret}`);
      },
      async getPrice(symbol) {
        priceCalls += 1;
        return { symbol, price: 3500, timestampMs: Date.now() };
      },
    };
    const connector = new BinanceConnector(liveMainnetConfig, client, "live");
    const result = await connector.revalidate(binanceSpotOrder);
    expect(result.passed).toBe(false);
    expect(result.reason).not.toContain(config.apiSecret);
    expect(priceCalls).toBe(0);
  });

  it("never queries API key permissions on live testnet", async () => {
    let permissionCalls = 0;
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getApiKeyPermissions() {
        permissionCalls += 1;
        throw new Error("testnet must not query SAPI");
      },
    };
    const connector = new BinanceConnector(config, client, "live");
    expect((await connector.revalidate(binanceSpotOrder)).passed).toBe(true);
    const result = await connector.execute(binanceSpotOrder);
    expect(result.orderId).toBe("live-spot-001");
    expect(permissionCalls).toBe(0);
  });

  it("returns matched reconciliation for an accepted live fill", async () => {
    const connector = new BinanceConnector(liveMainnetConfig, makeMockClient(), "live");
    const result = await connector.execute(binanceSpotOrder);
    expect(result.orderId).toBe("live-spot-001");
    expect(result.orderStatus?.status).toBe("FILLED");
    expect(result.reconciliation).toMatchObject({
      status: "matched",
      expected: { orderId: "live-spot-001", status: "FILLED", executedQty: 0.002 },
      observed: { orderId: "live-spot-001", status: "FILLED", executedQty: 0.002 },
      discrepancies: [],
    });
  });

  it("returns matched reconciliation for an accepted live futures fill", async () => {
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getPrice(symbol) {
        return { symbol, price: binanceFuturesOrder.price, timestampMs: Date.now() };
      },
    };
    const connector = new BinanceConnector(liveMainnetFuturesConfig, client, "live");
    const result = await connector.execute(binanceFuturesOrder);
    expect(result.orderId).toBe("live-futures-001");
    expect(result.orderStatus).toMatchObject({
      orderId: "live-futures-001",
      side: "SELL",
      status: "FILLED",
      executedQty: 0.00004,
      avgPrice: 100000,
    });
    expect(result.reconciliation).toMatchObject({
      status: "matched",
      expected: { orderId: "live-futures-001", status: "FILLED", executedQty: 0.00004 },
      observed: { orderId: "live-futures-001", status: "FILLED", executedQty: 0.00004 },
      discrepancies: [],
    });
  });

  it("does not cache live API key permissions across revalidation", async () => {
    let permissionCalls = 0;
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getApiKeyPermissions() {
        permissionCalls += 1;
        if (permissionCalls === 1) return { ...safePermissions };
        return { ...safePermissions, enableWithdrawals: true };
      },
    };
    const connector = new BinanceConnector(liveMainnetConfig, client, "live");
    expect((await connector.revalidate(binanceSpotOrder)).passed).toBe(true);
    const second = await connector.revalidate(binanceSpotOrder);
    expect(second.passed).toBe(false);
    expect(permissionCalls).toBe(2);
  });

  it("treats an unfilled accepted LIMIT as matched rather than a failed fill", async () => {
    const acknowledged = {
      orderId: "live-spot-new",
      symbol: "ETH-USDC",
      side: "BUY",
      status: "NEW",
      executedQty: 0,
      avgPrice: 0,
    };
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async placeSpotOrder() {
        return acknowledged;
      },
      async getOrderStatus() {
        return acknowledged;
      },
    };
    const connector = new BinanceConnector(liveMainnetConfig, client, "live");
    const result = await connector.execute(binanceSpotOrder);
    expect(result.orderId).toBe("live-spot-new");
    expect(result.orderStatus?.status).toBe("NEW");
    expect(result.reconciliation?.status).toBe("matched");
    expect(result.reconciliation?.discrepancies).toEqual([]);
  });

  it("preserves the accepted order when status lookup is unavailable", async () => {
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getOrderStatus() {
        throw new Error(`order lookup leaked ${config.apiSecret}`);
      },
    };
    const connector = new BinanceConnector(liveMainnetConfig, client, "live");
    const result = await connector.execute(binanceSpotOrder);
    expect(result.orderId).toBe("live-spot-001");
    expect(result.orderStatus).toMatchObject({
      orderId: "live-spot-001",
      status: "FILLED",
      executedQty: 0.002,
    });
    expect(result.reconciliation).toMatchObject({
      status: "unavailable",
      expected: { orderId: "live-spot-001", status: "FILLED" },
      discrepancies: [ORDER_STATUS_LOOKUP_FAILED],
    });
    expect(result.reconciliation?.observed).toBeUndefined();
    expect(JSON.stringify(result.reconciliation)).not.toContain(config.apiSecret);
  });

  it("flags identity, overfill, and limit-price mismatches as discrepancies without dropping the order", async () => {
    const cases = [
      {
        name: "identity",
        observed: {
          orderId: "other-order",
          symbol: "ETH-USDC",
          side: "BUY",
          status: "FILLED",
          executedQty: 0.002,
          avgPrice: 3500,
        },
      },
      {
        name: "overfill",
        observed: {
          orderId: "live-spot-001",
          symbol: "ETH-USDC",
          side: "BUY",
          status: "FILLED",
          executedQty: 0.003,
          avgPrice: 3500,
        },
      },
      {
        name: "limit",
        observed: {
          orderId: "live-spot-001",
          symbol: "ETH-USDC",
          side: "BUY",
          status: "FILLED",
          executedQty: 0.002,
          avgPrice: 3600,
        },
      },
    ];
    for (const testCase of cases) {
      const client: BinanceApiClient = {
        ...makeMockClient(),
        async getOrderStatus() {
          return testCase.observed;
        },
      };
      const connector = new BinanceConnector(liveMainnetConfig, client, "live");
      const result = await connector.execute(binanceSpotOrder);
      expect(result.orderId, testCase.name).toBe("live-spot-001");
      expect(result.orderStatus?.status, testCase.name).toBe("FILLED");
      expect(result.reconciliation?.status, testCase.name).toBe("discrepancy");
      expect(result.reconciliation?.observed, testCase.name).toEqual(testCase.observed);
    }
  });
});
