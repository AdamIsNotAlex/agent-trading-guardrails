import {
  binanceCancelOrder,
  binanceFuturesOrder,
  binanceOrderStatus,
  binanceSpotOrder,
} from "@guardrails/schemas/fixtures";
import { describe, expect, it } from "vitest";
import { BinanceConnector } from "./connector.js";
import type { BinanceApiClient, BinanceConfig } from "./interfaces.js";

const config: BinanceConfig = {
  apiKey: "test-key",
  apiSecret: "test-secret",
  testnet: true,
  allowedAccounts: ["subaccount-1", "subaccount-2"],
  allowedSpotSymbols: ["ETH-USDC", "BTC-USDC"],
  allowedFuturesSymbols: ["BTC-USDT", "ETH-USDT"],
  maxFuturesLeverage: 3,
};

function makeMockClient(): BinanceApiClient {
  return {
    async getPrice(symbol) {
      return { symbol, price: 3500, timestampMs: Date.now() };
    },
    async getAccountSnapshot(account) {
      return { account, balances: [], positions: [], timestampMs: Date.now() };
    },
    async placeSpotOrder(params) {
      return {
        orderId: "live-spot-001",
        symbol: params.symbol,
        side: params.side,
        status: "FILLED",
        executedQty: 0.002,
        avgPrice: 3500,
      };
    },
    async placeFuturesOrder(params) {
      return {
        orderId: "live-futures-001",
        symbol: params.symbol,
        side: params.side,
        status: "FILLED",
        executedQty: 0.0001,
        avgPrice: 100000,
      };
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
      return {
        orderId: params.orderId,
        symbol: params.symbol,
        side: "BUY",
        status: "FILLED",
        executedQty: 0.002,
        avgPrice: 3500,
      };
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
    const connector = new BinanceConnector(config, null, "paper");
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

  it("does not fetch live market data when revalidating order status", async () => {
    const client: BinanceApiClient = {
      ...makeMockClient(),
      async getPrice() {
        throw new Error("getPrice should not be called");
      },
    };
    const connector = new BinanceConnector(config, client, "live");
    const result = await connector.revalidate(binanceOrderStatus);
    expect(result.passed).toBe(true);
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
    const connector = new BinanceConnector(config, null, "paper");
    const intent = { ...binanceFuturesOrder, leverage: 10 };
    const result = await connector.revalidate(intent);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Leverage");
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
