import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BinanceRestClient } from "./rest-client.js";
import type { BinanceRestConfig } from "./rest-types.js";

const now = Date.parse("2026-10-10T12:00:00.000Z");
const dayStart = Date.parse("2026-10-10T00:00:00.000Z");
const config: BinanceRestConfig = {
  account: "dedicated",
  accountMode: "spot",
  apiKey: "fixture-api-key",
  apiSecret: "fixture-secret",
  testnet: true,
  allowedAccounts: ["dedicated"],
  allowedSpotSymbols: ["ETH-USDC"],
  allowedFuturesSymbols: [],
  historySymbols: ["ETH-USDC"],
  maxFuturesLeverage: 2,
};
const order = {
  symbol: "ETHUSDC",
  orderId: 123,
  side: "BUY",
  status: "FILLED",
  executedQty: "2",
  cummulativeQuoteQty: "6000",
  avgPrice: "3000",
};
const params = {
  account: "dedicated",
  symbol: "ETH-USDC",
  side: "BUY" as const,
  type: "LIMIT" as const,
  quantity: 2,
  price: 3000,
  clientOrderId: "guardrails-example",
};
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function client(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  overrides: Partial<BinanceRestConfig> = {},
) {
  return new BinanceRestClient(
    { ...config, ...overrides },
    {
      now: () => now,
      fetch: async (input, init) => handler(new URL(String(input)), init ?? {}),
    },
  );
}
const futures: Partial<BinanceRestConfig> = {
  accountMode: "usdm_futures",
  allowedSpotSymbols: [],
  allowedFuturesSymbols: ["ETH-USDC"],
};
function fill(id: number, time = dayStart + 100) {
  return {
    symbol: "ETHUSDC",
    id,
    orderId: id,
    price: "3000",
    qty: "1",
    quoteQty: "3000",
    commission: "1",
    commissionAsset: "USDC",
    time,
    isBuyer: true,
    side: "BUY",
  };
}

describe("Binance signed REST", () => {
  it("authenticates exact encoded bytes and sends a GTC decimal order without account alias leakage", async () => {
    let sent = false;
    const api = client((url, init) => {
      expect(url.origin).toBe("https://testnet.binance.vision");
      expect(url.pathname).toBe("/api/v3/order");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("x-mbx-apikey")).toBe(config.apiKey);
      const signature = url.searchParams.get("signature");
      url.searchParams.delete("signature");
      expect(signature).toBe(
        createHmac("sha256", config.apiSecret).update(url.searchParams.toString()).digest("hex"),
      );
      expect(url.searchParams.get("timestamp")).toBe(String(now));
      expect(url.searchParams.get("recvWindow")).toBe("5000");
      expect(url.searchParams.get("timeInForce")).toBe("GTC");
      expect(url.searchParams.get("quantity")).toBe("0.0000001");
      expect(url.searchParams.get("account")).toBeNull();
      expect(url.searchParams.get("newClientOrderId")).toBe(params.clientOrderId);
      sent = true;
      return response(order);
    });
    const result = await api.placeSpotOrder({ ...params, quantity: 1e-7 });
    expect(sent).toBe(true);
    expect(result).toEqual({
      orderId: "123",
      symbol: "ETH-USDC",
      side: "BUY",
      status: "FILLED",
      executedQty: 2,
      avgPrice: 3000,
    });
  });

  it("selects the bound market and network for public quotes without attaching credentials", async () => {
    for (const [overrides, origin, path] of [
      [{ testnet: false }, "https://api.binance.com", "/api/v3/ticker/price"],
      [futures, "https://demo-fapi.binance.com", "/fapi/v2/ticker/price"],
      [{ ...futures, testnet: false }, "https://fapi.binance.com", "/fapi/v2/ticker/price"],
    ] as const) {
      const api = client((url, init) => {
        expect(url.origin).toBe(origin);
        expect(url.pathname).toBe(path);
        expect(new Headers(init.headers).get("x-mbx-apikey")).toBeNull();
        expect(url.searchParams.has("signature")).toBe(false);
        return response({ symbol: "ETHUSDC", price: "3000", time: now - 10 });
      }, overrides);
      expect((await api.getPrice("ETH-USDC")).price).toBe(3000);
    }
  });

  it("does not send credentials for an unbound account or unsupported symbol", async () => {
    let requests = 0;
    const api = client(() => {
      requests++;
      return response(order);
    });
    await expect(api.placeSpotOrder({ ...params, account: "another-account" })).rejects.toThrow();
    await expect(api.getPrice("BTC-USDT")).rejects.toThrow();
    await expect(api.placeFuturesOrder({ ...params, leverage: 1 })).rejects.toThrow();
    expect(requests).toBe(0);
  });

  it("rejects mismatched order identities and malformed prices instead of reporting a different execution", async () => {
    const wrongOrder = client(() => response({ ...order, orderId: 456 }));
    await expect(
      wrongOrder.getOrderStatus({ account: params.account, symbol: params.symbol, orderId: "123" }),
    ).rejects.toThrow();
    const wrongSymbol = client(() => response({ ...order, symbol: "BTCUSDT" }));
    await expect(wrongSymbol.placeSpotOrder(params)).rejects.toThrow();
    for (const price of ["", "NaN", "Infinity", "-1", "0", null]) {
      await expect(
        client(() => response({ symbol: "ETHUSDC", price })).getPrice("ETH-USDC"),
      ).rejects.toThrow();
    }
  });

  it("never retries uncertain writes and does not leak raw errors or signed URLs", async () => {
    let writes = 0;
    const api = client(() => {
      writes++;
      return response(
        { code: -1007, msg: `${config.apiKey} ${config.apiSecret} signature=secret` },
        503,
      );
    });
    const error = await api.placeSpotOrder(params).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(config.apiKey);
    expect(String(error)).not.toContain(config.apiSecret);
    expect(String(error)).not.toContain("signature=");
    expect(writes).toBe(1);
    const transport = client(() => {
      throw new Error(`fetch https://secret?signature=${config.apiSecret}`);
    });
    await expect(transport.placeSpotOrder(params)).rejects.not.toThrow(config.apiSecret);
  });

  it("uses DELETE for cancellation in the bound futures market", async () => {
    const api = client((url, init) => {
      expect(url.pathname).toBe("/fapi/v1/order");
      expect(init.method).toBe("DELETE");
      expect(url.searchParams.get("orderId")).toBe("123");
      return response({ ...order, status: "CANCELED" });
    }, futures);
    expect(
      (await api.cancelOrder({ account: params.account, symbol: params.symbol, orderId: "123" }))
        .status,
    ).toBe("CANCELED");
  });

  it("requires isolated one-way futures and verifies leverage before placing the order", async () => {
    const sent: string[] = [];
    const api = client((url, init) => {
      sent.push(`${init.method} ${url.pathname}`);
      if (url.pathname.endsWith("positionRisk"))
        return response([{ symbol: "ETHUSDC", positionSide: "BOTH", marginType: "isolated" }]);
      if (url.pathname.endsWith("leverage")) return response({ symbol: "ETHUSDC", leverage: 2 });
      expect(url.searchParams.get("positionSide")).toBe("BOTH");
      return response(order);
    }, futures);
    expect((await api.placeFuturesOrder({ ...params, leverage: 2 })).orderId).toBe("123");
    expect(sent).toEqual([
      "GET /fapi/v2/positionRisk",
      "POST /fapi/v1/leverage",
      "POST /fapi/v1/order",
    ]);
    for (const position of [
      { positionSide: "BOTH", marginType: "cross" },
      { positionSide: "LONG", marginType: "isolated" },
    ]) {
      let posts = 0;
      const blocked = client((_url, init) => {
        if (init.method === "POST") posts++;
        return response([{ symbol: "ETHUSDC", ...position }]);
      }, futures);
      await expect(blocked.placeFuturesOrder({ ...params, leverage: 1 })).rejects.toThrow();
      expect(posts).toBe(0);
    }
  });

  it("values free plus locked spot inventory and refuses uncovered balances", async () => {
    const api = client((url) =>
      url.pathname.endsWith("account")
        ? response({
            balances: [
              { asset: "ETH", free: "1", locked: "2" },
              { asset: "USDC", free: "10", locked: "0" },
            ],
          })
        : response({ symbol: "ETHUSDC", price: "3000" }),
    );
    expect((await api.getAccountSnapshot("dedicated")).positions).toEqual([
      { symbol: "ETH-USDC", quantity: 3, notionalUsd: 9000, leverage: 1 },
    ]);
    await expect(
      client(() =>
        response({ balances: [{ asset: "BNB", free: "1", locked: "0" }] }),
      ).getAccountSnapshot("dedicated"),
    ).rejects.toThrow();
  });

  it("preserves signed futures short exposure from real position fields", async () => {
    const api = client(
      (url) =>
        url.pathname.endsWith("account")
          ? response({ assets: [{ asset: "USDC", walletBalance: "100", availableBalance: "80" }] })
          : response([
              {
                symbol: "ETHUSDC",
                positionSide: "BOTH",
                positionAmt: "-2",
                notional: "-6000",
                leverage: "2",
                marginType: "isolated",
              },
            ]),
      futures,
    );
    expect((await api.getAccountSnapshot("dedicated")).positions).toEqual([
      { symbol: "ETH-USDC", quantity: -2, notionalUsd: -6000, leverage: 2 },
    ]);
  });
});

describe("Binance complete history collection", () => {
  it("backfills spot trades with an ID cursor rather than silently using the latest page", async () => {
    const api = client((url) => {
      if (url.pathname.endsWith("myTrades")) {
        const cursor = Number(url.searchParams.get("fromId"));
        if (cursor === 0) return response(Array.from({ length: 1000 }, (_, n) => fill(n + 1)));
        expect(cursor).toBe(1001);
        return response([fill(1001)]);
      }
      return response(
        url.searchParams.get("limit") === "1"
          ? [{ symbol: "ETHUSDC", orderId: 99, time: dayStart - 1 }]
          : [{ symbol: "ETHUSDC", orderId: 1000, time: dayStart + 1 }],
      );
    });
    const history = await api.getRiskHistory("dedicated", "2026-10-10");
    expect(history.trades.at(-1)?.id).toBe("1001");
    expect(history.orders).toEqual([
      { symbol: "ETH-USDC", orderId: "1000", timestampMs: dayStart + 1 },
    ]);
    expect(history.lastOrderTimestampMs).toBe(dayStart - 1);
  });

  it("splits saturated time windows without dropping fills sharing a millisecond boundary", async () => {
    const middle = dayStart + (now - dayStart) / 2;
    const fills = Array.from({ length: 1001 }, (_, i) =>
      fill(i + 1, i < 500 ? middle : middle + 1),
    );
    const api = client((url) => {
      if (url.pathname.endsWith("userTrades")) {
        const start = Number(url.searchParams.get("startTime"));
        const end = Number(url.searchParams.get("endTime"));
        return response(
          fills.filter((item) => item.time >= start && item.time <= end).slice(0, 1000),
        );
      }
      return response([]);
    }, futures);
    const history = await api.getRiskHistory("dedicated", "2026-10-10");
    expect(history.trades.reduce((total, item) => total + item.quoteQuantity, 0)).toBe(3_003_000);
    expect(new Set(history.trades.map((item) => item.id)).size).toBe(1001);
  });

  it("rejects a saturated millisecond and a stuck ID cursor instead of returning partial risk data", async () => {
    const sameTime = Array.from({ length: 1000 }, (_, i) => fill(i + 1, dayStart));
    const api = client((url) => {
      if (url.pathname.endsWith("userTrades"))
        return response(Number(url.searchParams.get("startTime")) === dayStart ? sameTime : []);
      return response([]);
    }, futures);
    await expect(api.getRiskHistory("dedicated", "2026-10-10")).rejects.toThrow();
    const stuck = client((url) =>
      url.pathname.endsWith("myTrades") ? response(sameTime) : response([]),
    );
    await expect(stuck.getRiskHistory("dedicated", "2026-10-10")).rejects.toThrow();
  });

  it("paginates income without counting repeated pages as new losses", async () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      tranId: i + 1,
      symbol: "ETHUSDC",
      incomeType: "COMMISSION",
      income: "-1",
      asset: "USDC",
      time: dayStart + 10,
    }));
    const api = client((url) => {
      if (url.pathname.endsWith("income"))
        return response(
          url.searchParams.get("page") === "1" ? entries : [{ ...entries[0], tranId: 1001 }],
        );
      return response([]);
    }, futures);
    expect(
      (await api.getRiskHistory("dedicated", "2026-10-10")).income.reduce(
        (total, item) => total + item.income,
        0,
      ),
    ).toBe(-1001);
    const stuck = client(
      (url) => response(url.pathname.endsWith("income") ? entries : []),
      futures,
    );
    await expect(stuck.getRiskHistory("dedicated", "2026-10-10")).rejects.toThrow();
  });
});
