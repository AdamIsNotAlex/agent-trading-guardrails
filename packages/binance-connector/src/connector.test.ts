import {
  binanceCancelOrder,
  binanceFuturesOrder,
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

  it("revalidates with live market data", async () => {
    const connector = new BinanceConnector(config, makeMockClient(), "live");
    const result = await connector.revalidate(binanceSpotOrder);
    expect(result.passed).toBe(true);
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
