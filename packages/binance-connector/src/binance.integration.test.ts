import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { ConnectorRevalidationError } from "@guardrails/broker";
import {
  binanceCancelOrder,
  binanceOrderStatus,
  binanceSpotOrder,
} from "@guardrails/schemas/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { BinanceConnector } from "./connector.js";
import type { BinanceAccountMode } from "./interfaces.js";
import { BinanceRestClient } from "./rest-client.js";
import type { BinanceRestConfig, BinanceRestOptions } from "./rest-types.js";

const servers: Server[] = [];
const fixtureErrors: unknown[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  const errors = fixtureErrors.splice(0);
  if (errors.length) throw new AggregateError(errors, "Invalid HTTP exchange request");
});

async function exchange(product: BinanceAccountMode = "spot", testnet = true, timeoutMs = 5000) {
  const config: BinanceRestConfig = {
    apiKey: "http-fixture-key",
    apiSecret: "http-fixture-secret",
    testnet,
    account: "subaccount-1",
    accountMode: product,
    allowedAccounts: ["subaccount-1"],
    allowedSpotSymbols: product === "spot" ? ["ETH-USDC"] : [],
    allowedFuturesSymbols: product === "spot" ? [] : ["ETH-USDC"],
    historySymbols: ["ETH-USDC", "BTC-USDC"],
    maxFuturesLeverage: 2,
    ipAllowlist: testnet ? [] : ["203.0.113.10"],
  };
  const state = {
    status: "NEW",
    accepted: false,
    leverage: 0,
    margin: "isolated",
    statusUnavailable: false,
    fault: "none" as "none" | "reject" | "ticker" | "hang" | "malformed-order",
    withdrawals: false,
    spotTrading: true,
    futuresTrading: true,
  };
  const requests: { method: string; path: string }[] = [];
  const prefix = product === "spot" ? "/api/v3" : "/fapi/v1";
  const ticker = product === "spot" ? "/api/v3/ticker/price" : "/fapi/v2/ticker/price";
  const wireOrder = () => ({
    orderId: 12345,
    symbol: "ETHUSDC",
    side: "BUY",
    status: state.status,
    executedQty: "0",
    cummulativeQuoteQty: "0",
    avgPrice: "0",
  });
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://fixture");
      const method = request.method ?? "";
      requests.push({ method, path: url.pathname });
      response.setHeader("content-type", "application/json");
      assert.equal(url.searchParams.has("account"), false);
      if (url.pathname === ticker) {
        assert.equal(method, "GET");
        assert.equal(request.headers["x-mbx-apikey"], undefined);
        assert.equal(url.searchParams.has("signature"), false);
        if (state.fault === "hang") return;
        response.end(
          JSON.stringify({
            symbol: "ETHUSDC",
            price: state.fault === "ticker" ? "NaN" : "3500",
            time: Date.now(),
          }),
        );
        return;
      }
      assert.equal(request.headers["x-mbx-apikey"], config.apiKey);
      const signature = url.searchParams.get("signature");
      url.searchParams.delete("signature");
      assert.equal(
        signature,
        createHmac("sha256", config.apiSecret).update(url.searchParams.toString()).digest("hex"),
      );
      assert.match(url.searchParams.get("timestamp") ?? "", /^\d+$/);
      assert.equal(url.searchParams.get("recvWindow"), "5000");
      if (url.pathname === "/sapi/v1/account/apiRestrictions") {
        assert.equal(testnet, false, "Testnet credentials must never reach SAPI");
        response.end(
          JSON.stringify({
            ipRestrict: true,
            enableWithdrawals: state.withdrawals,
            enableReading: true,
            enableSpotAndMarginTrading: state.spotTrading,
            enableFutures: state.futuresTrading,
          }),
        );
      } else if (url.pathname === "/fapi/v2/positionRisk") {
        response.end(
          JSON.stringify([{ symbol: "ETHUSDC", positionSide: "BOTH", marginType: state.margin }]),
        );
      } else if (url.pathname === "/fapi/v1/leverage") {
        assert.equal(method, "POST");
        state.leverage = Number(url.searchParams.get("leverage"));
        response.end(JSON.stringify({ symbol: "ETHUSDC", leverage: state.leverage }));
      } else if (url.pathname === `${prefix}/order`) {
        assert.equal(url.searchParams.get("symbol"), "ETHUSDC");
        if (method === "POST") {
          assert.equal(url.searchParams.get("type"), "LIMIT");
          assert.equal(url.searchParams.get("timeInForce"), "GTC");
          assert.equal(url.searchParams.get("quantity"), "0.002");
          assert.equal(url.searchParams.get("price"), "3500");
          assert.match(url.searchParams.get("newClientOrderId") ?? "", /^guardrails-[a-f0-9]{24}$/);
          if (product === "usdm_futures") {
            assert.equal(url.searchParams.get("positionSide"), "BOTH");
            assert.equal(state.leverage, 2);
          }
          if (state.fault === "reject") {
            response.statusCode = 400;
            response.end(
              JSON.stringify({ code: -2010, msg: `${config.apiKey} ${config.apiSecret}` }),
            );
            return;
          }
          state.accepted = true;
        } else {
          assert.equal(state.accepted, true);
          assert.equal(url.searchParams.get("orderId"), "12345");
          if (method === "DELETE") state.status = "CANCELED";
          else {
            assert.equal(method, "GET");
            if (state.statusUnavailable) {
              response.statusCode = 503;
              response.end("{}");
              return;
            }
          }
        }
        response.end(
          JSON.stringify(
            state.fault === "malformed-order"
              ? { ...wireOrder(), orderId: "invalid" }
              : wireOrder(),
          ),
        );
      } else {
        throw new Error(`Unexpected exchange route ${method} ${url.pathname}`);
      }
    } catch (error) {
      fixtureErrors.push(error);
      response.statusCode = 500;
      response.end("{}");
    }
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin =
    product === "spot"
      ? testnet
        ? "https://testnet.binance.vision"
        : "https://api.binance.com"
      : testnet
        ? "https://demo-fapi.binance.com"
        : "https://fapi.binance.com";
  const options: BinanceRestOptions = {
    timeoutMs,
    // Redirect only the destination. Real HTTP, request bytes and response parsing remain intact.
    fetch: (input, init) => {
      const url = new URL(String(input));
      assert.ok(
        url.origin === origin ||
          (!testnet &&
            url.origin === "https://api.binance.com" &&
            url.pathname.startsWith("/sapi/")),
      );
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
    },
  };
  const connect = (currentConfig = config) => {
    const client = new BinanceRestClient(currentConfig, options);
    return { client, connector: new BinanceConnector(currentConfig, client, "live") };
  };
  const intent = {
    ...binanceSpotOrder,
    intentId: randomUUID(),
    idempotencyKey: randomUUID(),
    requestedAt: new Date().toISOString(),
    environment: "testnet" as const,
    accountMode: product,
    ...(product === "usdm_futures" ? { marginType: "isolated" as const, leverage: 2 } : {}),
  };
  return { ...connect(), config, connect, state, requests, intent };
}

describe("Binance connector with a stateful HTTP exchange", () => {
  it.each([
    "spot",
    "usdm_futures",
  ] as const)("places, reconciles, queries and cancels %s orders", async (product) => {
    const { connector, intent, state } = await exchange(product);
    const placed = await connector.execute(intent);
    expect(placed).toMatchObject({
      orderId: "12345",
      orderStatus: { status: "NEW", symbol: "ETH-USDC" },
      reconciliation: { status: "matched" },
    });
    expect(
      await connector.getOrderStatus({
        account: intent.account,
        symbol: intent.symbol,
        orderId: "12345",
      }),
    ).toMatchObject({ status: "NEW", executedQty: 0 });
    expect(
      await connector.execute({ ...binanceCancelOrder, environment: "testnet", orderId: "12345" }),
    ).toEqual({ orderId: "12345" });
    expect(
      await connector.getOrderStatus({
        account: intent.account,
        symbol: intent.symbol,
        orderId: "12345",
      }),
    ).toMatchObject({ status: "CANCELED", executedQty: 0 });
    expect(state.status).toBe("CANCELED");
  });

  it.each([
    "spot",
    "usdm_futures",
  ] as const)("keeps retired %s orders queryable and cancellable without allowing new orders", async (product) => {
    const { connector, config, connect, intent, state, requests } = await exchange(product, false);
    await connector.execute(intent);
    const { connector: retired } = connect({
      ...config,
      allowedSpotSymbols: product === "spot" ? ["BTC-USDC"] : [],
      allowedFuturesSymbols: product === "usdm_futures" ? ["BTC-USDC"] : [],
    });
    const cancel = { ...binanceCancelOrder, orderId: "12345" };
    const status = { ...binanceOrderStatus, orderId: "12345" };
    const before = requests.length;

    // The opposite product's permission must not be needed for this account's old orders.
    state.spotTrading = product === "spot";
    state.futuresTrading = product === "usdm_futures";
    expect(await retired.revalidate(cancel)).toEqual({ passed: true });
    expect(await retired.revalidate(status)).toEqual({ passed: true });
    expect(await retired.execute(status)).toMatchObject({
      orderId: "12345",
      orderStatus: { status: "NEW" },
    });
    expect(await retired.execute(cancel)).toEqual({ orderId: "12345" });
    expect(state.status).toBe("CANCELED");
    expect(await retired.execute(status)).toMatchObject({
      orderId: "12345",
      orderStatus: { status: "CANCELED" },
    });
    const path = product === "spot" ? "/api/v3/order" : "/fapi/v1/order";
    expect(requests.slice(before).filter((request) => request.path === path)).toEqual([
      { method: "GET", path },
      { method: "DELETE", path },
      { method: "GET", path },
    ]);

    const afterManagement = requests.length;
    expect((await retired.revalidate(intent)).passed).toBe(false);
    await expect(retired.execute(intent)).rejects.toThrow(ConnectorRevalidationError);
    for (const management of [cancel, status]) {
      await expect(retired.execute({ ...management, symbol: "DOGE-USDT" })).rejects.toThrow(
        ConnectorRevalidationError,
      );
      await expect(retired.execute({ ...management, account: "other" })).rejects.toThrow(
        ConnectorRevalidationError,
      );
    }
    expect(requests.slice(afterManagement)).toEqual([]);

    // Removing a trading symbol must not remove its product's API-key permission check.
    state.spotTrading = product !== "spot";
    state.futuresTrading = product !== "usdm_futures";
    await expect(retired.execute(cancel)).rejects.toThrow(ConnectorRevalidationError);
    expect(requests.slice(afterManagement)).toEqual([
      { method: "GET", path: "/sapi/v1/account/apiRestrictions" },
    ]);
  });

  it("retains the accepted order when reconciliation HTTP fails", async () => {
    const { connector, state, intent, requests } = await exchange();
    state.statusUnavailable = true;
    expect(await connector.execute(intent)).toMatchObject({
      orderId: "12345",
      orderStatus: { status: "NEW" },
      reconciliation: { status: "unavailable" },
    });
    expect(requests.filter((request) => request.method === "POST")).toEqual([
      { method: "POST", path: "/api/v3/order" },
    ]);
  });

  it.each([
    "ticker",
    "hang",
  ] as const)("fails closed for %s market HTTP data before submitting an order", async (fault) => {
    // The hang case tests the real fetch abort/socket boundary; no guessed sleep or fake remote clock.
    const { connector, state, intent, requests } = await exchange(
      "spot",
      true,
      fault === "hang" ? 100 : 5000,
    );
    state.fault = fault;
    await expect(connector.execute(intent)).rejects.toThrow();
    expect(state.accepted).toBe(false);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it.each([
    "reject",
    "malformed-order",
  ] as const)("does not fabricate success for %s order responses or expose reflected credentials", async (fault) => {
    const { connector, state, intent } = await exchange();
    state.fault = fault;
    const error = await connector.execute(intent).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("http-fixture-key");
    expect(String(error)).not.toContain("http-fixture-secret");
    expect(error).not.toHaveProperty("orderId");
  });

  it("blocks account and product mismatches without sending a signed request", async () => {
    const { connector, client, intent, requests } = await exchange();
    await expect(connector.execute({ ...intent, account: "other" })).rejects.toThrow();
    await expect(
      client.placeFuturesOrder({
        account: intent.account,
        symbol: intent.symbol,
        side: "BUY",
        type: "LIMIT",
        price: 3500,
        quantity: 0.002,
        leverage: 1,
      }),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("blocks cross-margin futures before leverage or order mutation", async () => {
    const { connector, intent, state, requests } = await exchange("usdm_futures");
    state.margin = "cross";
    await expect(connector.execute(intent)).rejects.toThrow();
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(state.accepted).toBe(false);
  });

  it("checks mainnet permission HTTP and blocks withdrawal-enabled credentials", async () => {
    const { connector, state, intent, requests } = await exchange("spot", false);
    state.withdrawals = true;
    await expect(connector.execute(intent)).rejects.toThrow();
    expect(requests).toEqual([{ method: "GET", path: "/sapi/v1/account/apiRestrictions" }]);
    expect(state.accepted).toBe(false);
  });
});
