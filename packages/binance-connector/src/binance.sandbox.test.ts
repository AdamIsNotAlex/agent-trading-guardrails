import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { binanceCancelOrder, binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { describe, expect, it } from "vitest";
import { BinanceConnector } from "./connector.js";
import { BinanceRestClient } from "./rest-client.js";
import type { BinanceRestConfig } from "./rest-types.js";

const origin = "https://testnet.binance.vision"; // Never configurable; never reuse mainnet credentials.
const apiKey = process.env.BINANCE_TESTNET_API_KEY?.trim();
const apiSecret = process.env.BINANCE_TESTNET_API_SECRET?.trim();
const scale = 100_000_000n;
const ceilingUsd = 25;
type Filter = Record<string, string> & { filterType: string };

function units(value: string): bigint {
  assert.match(value, /^\d+(\.\d{1,8})?$/, "Unsupported exchange decimal precision");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * scale + BigInt(fraction.padEnd(8, "0"));
}
function ceil(value: bigint, step: bigint) {
  assert.ok(step > 0n, "Exchange step must be positive");
  return ((value + step - 1n) / step) * step;
}

async function request(
  path: string,
  params: Record<string, string> = {},
  method = "GET",
  signed = false,
) {
  const query = new URLSearchParams(params);
  if (signed) {
    assert.ok(apiKey && apiSecret, "Both dedicated testnet credentials are required");
    query.set("timestamp", String(Date.now()));
    query.set("recvWindow", "5000");
    query.set("signature", createHmac("sha256", apiSecret).update(query.toString()).digest("hex"));
  }
  // This is a real exchange deadline, not a synchronization sleep; fake time cannot drive its TLS I/O.
  const response = await fetch(`${origin}${path}?${query}`, {
    method,
    headers: signed && apiKey ? { "X-MBX-APIKEY": apiKey } : {},
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`Testnet ${method} ${path} failed with HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

describe("Binance Spot testnet (dedicated credentials, at most 25 USDT test funds)", () => {
  it.skipIf(!apiKey && !apiSecret)(
    "places a small resting limit order, observes it and confirms cancellation",
    async () => {
      assert.ok(
        apiKey && apiSecret,
        "Set both BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET; partial configuration is an error",
      );
      const metadata = await request("/api/v3/exchangeInfo", { symbol: "BTCUSDT" });
      const symbols = metadata.symbols as { symbol: string; status: string; filters: Filter[] }[];
      assert.equal(symbols?.[0]?.symbol, "BTCUSDT");
      assert.equal(symbols[0].status, "TRADING");
      const filters = symbols[0].filters;
      const priceFilter = filters.find((filter) => filter.filterType === "PRICE_FILTER");
      const lot = filters.find((filter) => filter.filterType === "LOT_SIZE");
      const notional = filters.find(
        (filter) => filter.filterType === "NOTIONAL" || filter.filterType === "MIN_NOTIONAL",
      );
      assert.ok(
        priceFilter && lot && notional,
        "Exchange price, lot and minimum-notional filters are required",
      );
      const book = await request("/api/v3/ticker/bookTicker", { symbol: "BTCUSDT" });
      const tick = units(priceFilter.tickSize);
      assert.ok(tick > 0n);
      // Rest 1% below the best bid; no MARKET orders. A moving testnet can still fill before cancellation.
      const price = ((units(String(book.bidPrice)) * 99n) / 100n / tick) * tick;
      assert.ok(
        price > 0n && price >= units(priceFilter.minPrice) && price <= units(priceFilter.maxPrice),
      );
      const minimumNotional = (units(notional.minNotional) * 102n) / 100n;
      const required = (minimumNotional * scale + price - 1n) / price;
      const quantity = ceil(
        required > units(lot.minQty) ? required : units(lot.minQty),
        units(lot.stepSize),
      );
      assert.ok(quantity <= units(lot.maxQty));
      assert.ok(
        price * quantity <= BigInt(ceilingUsd) * scale * scale,
        "Filters exceed the fixed 25 USDT test ceiling; refusing to increase it",
      );
      if (notional.maxNotional && units(notional.maxNotional) > 0n) {
        assert.ok(price * quantity <= units(notional.maxNotional) * scale);
      }
      const percent = filters.filter((filter) =>
        ["PERCENT_PRICE", "PERCENT_PRICE_BY_SIDE"].includes(filter.filterType),
      );
      if (percent.length) {
        const average = units(
          String((await request("/api/v3/avgPrice", { symbol: "BTCUSDT" })).price),
        );
        for (const filter of percent) {
          const down = units(filter.bidMultiplierDown ?? filter.multiplierDown);
          const up = units(filter.bidMultiplierUp ?? filter.multiplierUp);
          assert.ok(
            price * scale >= average * down && price * scale <= average * up,
            "A passive price does not fit the current exchange price band",
          );
        }
      }
      const account = await request("/api/v3/account", {}, "GET", true);
      assert.equal(account.canTrade, true);
      const balances = account.balances as { asset: string; free: string }[];
      const usdt = balances.find((balance) => balance.asset === "USDT");
      assert.ok(
        usdt && units(usdt.free) * scale >= price * quantity,
        "Insufficient test USDT balance",
      );
      const config: BinanceRestConfig = {
        apiKey,
        apiSecret,
        testnet: true,
        account: "sandbox",
        accountMode: "spot",
        allowedAccounts: ["sandbox"],
        allowedSpotSymbols: ["BTC-USDT"],
        allowedFuturesSymbols: [],
        historySymbols: ["BTC-USDT"],
        maxFuturesLeverage: 1,
        ipAllowlist: [],
      };
      let attemptedClientId: string | undefined;
      let cancellationConfirmed = false;
      const client = new BinanceRestClient(config, {
        fetch: (input, init) => {
          const url = new URL(String(input));
          assert.equal(url.origin, origin);
          if (url.pathname === "/api/v3/order" && init?.method === "POST") {
            attemptedClientId = url.searchParams.get("newClientOrderId") ?? undefined;
            assert.ok(attemptedClientId, "Cleanup requires an identifier before sending any order");
          }
          return fetch(input, init);
        },
      });
      const connector = new BinanceConnector(config, client, "live");
      const intent = {
        ...binanceSpotOrder,
        intentId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestedAt: new Date().toISOString(),
        environment: "testnet" as const,
        account: "sandbox",
        resource: "cex:binance:sandbox:BTC-USDT",
        symbol: "BTC-USDT",
        quantity: Number(quantity) / Number(scale),
        price: Number(price) / Number(scale),
        maxNotionalUsd: ceilingUsd,
        maxSlippageBps: 200,
      };
      const errors: unknown[] = [];
      try {
        const placed = await connector.execute(intent);
        assert.ok(placed.orderId, "No accepted order identifier");
        const lookup = { account: config.account, symbol: intent.symbol, orderId: placed.orderId };
        expect(await client.getOrderStatus(lookup)).toMatchObject({
          status: "NEW",
          executedQty: 0,
        });
        await connector.execute({
          ...binanceCancelOrder,
          ...lookup,
          resource: intent.resource,
          environment: "testnet",
          intentId: randomUUID(),
          idempotencyKey: randomUUID(),
          requestedAt: new Date().toISOString(),
        });
        expect(await client.getOrderStatus(lookup)).toMatchObject({
          status: "CANCELED",
          executedQty: 0,
        });
        cancellationConfirmed = true;
      } catch (error) {
        errors.push(error);
      } finally {
        // Scope cleanup to this invocation's client id, including a lost/malformed POST response.
        // Failure to establish terminal state is a test failure, never a swallowed cleanup warning.
        if (attemptedClientId && !cancellationConfirmed) {
          const params = { symbol: "BTCUSDT", origClientOrderId: attemptedClientId };
          try {
            const observed = await request("/api/v3/order", params, "GET", true);
            if (
              !["CANCELED", "FILLED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"].includes(
                String(observed.status),
              )
            ) {
              await request("/api/v3/order", params, "DELETE", true);
              const terminal = await request("/api/v3/order", params, "GET", true);
              assert.ok(
                ["CANCELED", "FILLED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"].includes(
                  String(terminal.status),
                ),
              );
            }
          } catch {
            errors.push(
              new Error(
                `Testnet cleanup could not confirm terminal state for client order ${attemptedClientId}; inspect only this order on Spot testnet`,
              ),
            );
          }
        }
      }
      if (errors.length) throw new AggregateError(errors, "Spot testnet acceptance failed");
    },
  );
});
