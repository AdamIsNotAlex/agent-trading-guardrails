import { describe, expect, it } from "vitest";
import type { BinanceOrderResult } from "./interfaces.js";
import { reconcileAcceptedOrder } from "./reconciliation.js";

const approvedQuantity = 0.002;
const approvedPrice = 3500;
const acknowledged: BinanceOrderResult = {
  orderId: "42",
  symbol: "ETH-USDC",
  side: "BUY",
  status: "NEW",
  executedQty: 0,
  avgPrice: 0,
};
const partial = { ...acknowledged, status: "PARTIALLY_FILLED", executedQty: 0.001, avgPrice: 3490 };
const filled = {
  ...acknowledged,
  status: "FILLED",
  executedQty: approvedQuantity,
  avgPrice: approvedPrice,
};
function reconcile(observed: BinanceOrderResult, expected = acknowledged) {
  return reconcileAcceptedOrder({
    acknowledged: expected,
    observed,
    approvedQuantity,
    approvedPrice,
  });
}

describe("accepted-order reconciliation", () => {
  it("retains the accepted order when status cannot be queried", () => {
    const result = reconcileAcceptedOrder({
      acknowledged,
      lookupFailed: true,
      approvedQuantity,
      approvedPrice,
    });
    expect(result.status).toBe("unavailable");
    expect(result.expected.orderId).toBe(acknowledged.orderId);
    expect(result.expected.status).toBe("NEW");
    expect(result.observed).toBeUndefined();
  });

  it.each([
    { name: "unfilled limit", expected: acknowledged, observed: acknowledged },
    { name: "partial fill", expected: acknowledged, observed: partial },
    { name: "complete fill", expected: partial, observed: filled },
    {
      name: "cancellation after fill",
      expected: partial,
      observed: { ...partial, status: "CANCELED" },
    },
  ])("accepts $name without demanding an immediate fill", ({ expected, observed }) => {
    const result = reconcile(observed, expected);
    expect(result.status).toBe("matched");
    expect(result.discrepancies).toEqual([]);
  });

  it.each([
    {
      name: "wrong identity",
      expected: acknowledged,
      observed: { ...acknowledged, orderId: "43" },
    },
    {
      name: "wrong symbol",
      expected: acknowledged,
      observed: { ...acknowledged, symbol: "BTC-USDC" },
    },
    { name: "wrong side", expected: acknowledged, observed: { ...acknowledged, side: "SELL" } },
    { name: "overfill", expected: acknowledged, observed: { ...filled, executedQty: 0.003 } },
    {
      name: "buy limit violation",
      expected: acknowledged,
      observed: { ...filled, avgPrice: 3600 },
    },
    {
      name: "sell limit violation",
      expected: { ...acknowledged, side: "SELL" },
      observed: { ...filled, side: "SELL", avgPrice: 3400 },
    },
    { name: "status regression", expected: filled, observed: acknowledged },
    { name: "fill regression", expected: partial, observed: { ...partial, executedQty: 0.0005 } },
    {
      name: "empty FILLED",
      expected: acknowledged,
      observed: { ...acknowledged, status: "FILLED" },
    },
    {
      name: "empty partial fill",
      expected: acknowledged,
      observed: { ...acknowledged, status: "PARTIALLY_FILLED" },
    },
    { name: "NEW with fills", expected: acknowledged, observed: { ...filled, status: "NEW" } },
    {
      name: "complete partial fill",
      expected: acknowledged,
      observed: { ...filled, status: "PARTIALLY_FILLED" },
    },
    {
      name: "price changed without fills",
      expected: filled,
      observed: { ...filled, avgPrice: 3400 },
    },
    {
      name: "impossible acknowledgement",
      expected: { ...partial, status: "FILLED" },
      observed: filled,
    },
    {
      name: "inherited status name",
      expected: acknowledged,
      observed: { ...acknowledged, status: "constructor" },
    },
  ])("reports $name while retaining both pieces of evidence", ({ expected, observed }) => {
    const result = reconcile(observed, expected);
    expect(result.status).toBe("discrepancy");
    expect(result.expected).toEqual(expected);
    expect(result.observed).toEqual(observed);
  });
});
