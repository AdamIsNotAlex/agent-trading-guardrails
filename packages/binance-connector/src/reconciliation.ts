import type { BrokerOrderReconciliation, BrokerOrderStatus } from "@guardrails/schemas";
import type { BinanceOrderResult } from "./interfaces.js";

export const ORDER_STATUS_LOOKUP_FAILED =
  "Binance order status lookup failed after the order was accepted.";

const LEGAL_TRANSITIONS: Record<string, Record<string, true>> = {
  PENDING_NEW: {
    PENDING_NEW: true,
    NEW: true,
    PARTIALLY_FILLED: true,
    FILLED: true,
    CANCELED: true,
    PENDING_CANCEL: true,
    REJECTED: true,
    EXPIRED: true,
    EXPIRED_IN_MATCH: true,
  },
  NEW: {
    NEW: true,
    PARTIALLY_FILLED: true,
    FILLED: true,
    CANCELED: true,
    PENDING_CANCEL: true,
    REJECTED: true,
    EXPIRED: true,
    EXPIRED_IN_MATCH: true,
  },
  PARTIALLY_FILLED: {
    PARTIALLY_FILLED: true,
    FILLED: true,
    CANCELED: true,
    PENDING_CANCEL: true,
    EXPIRED: true,
    EXPIRED_IN_MATCH: true,
  },
  FILLED: { FILLED: true },
  CANCELED: { CANCELED: true },
  PENDING_CANCEL: {
    PENDING_CANCEL: true,
    CANCELED: true,
    PARTIALLY_FILLED: true,
    FILLED: true,
    EXPIRED: true,
    EXPIRED_IN_MATCH: true,
  },
  REJECTED: { REJECTED: true },
  EXPIRED: { EXPIRED: true },
  EXPIRED_IN_MATCH: { EXPIRED_IN_MATCH: true },
};

export function toBrokerOrderStatus(result: BinanceOrderResult): BrokerOrderStatus {
  return {
    orderId: result.orderId,
    symbol: result.symbol,
    side: result.side,
    status: result.status,
    executedQty: result.executedQty,
    avgPrice: result.avgPrice,
  };
}

export function reconcileAcceptedOrder(params: {
  acknowledged: BinanceOrderResult;
  observed?: BinanceOrderResult;
  lookupFailed?: boolean;
  approvedQuantity: number;
  approvedPrice: number;
  checkedAt?: string;
}): BrokerOrderReconciliation {
  const expected = toBrokerOrderStatus(params.acknowledged);
  const checkedAt = params.checkedAt ?? new Date().toISOString();
  if (params.lookupFailed || params.observed === undefined) {
    return {
      status: "unavailable",
      checkedAt,
      expected,
      discrepancies: [ORDER_STATUS_LOOKUP_FAILED],
    };
  }

  const observed = toBrokerOrderStatus(params.observed);
  const discrepancies = collectDiscrepancies(
    expected,
    observed,
    params.approvedQuantity,
    params.approvedPrice,
  );
  return {
    status: discrepancies.length === 0 ? "matched" : "discrepancy",
    checkedAt,
    expected,
    observed,
    discrepancies,
  };
}

function collectDiscrepancies(
  expected: BrokerOrderStatus,
  observed: BrokerOrderStatus,
  approvedQuantity: number,
  approvedPrice: number,
): string[] {
  const discrepancies: string[] = [];
  if (observed.orderId !== expected.orderId) {
    discrepancies.push("Reconciled order identity does not match the accepted order.");
  }
  if (observed.symbol !== expected.symbol) {
    discrepancies.push("Reconciled order symbol does not match the accepted order.");
  }
  if (observed.side !== expected.side) {
    discrepancies.push("Reconciled order side does not match the accepted order.");
  }
  if (!isLegalTransition(expected.status, observed.status)) {
    discrepancies.push("Reconciled order status is not a legal advancement of the accepted order.");
  }
  if (expected.executedQty > approvedQuantity) {
    discrepancies.push("Accepted filled quantity exceeds the approved quantity.");
  }
  if (observed.executedQty < expected.executedQty) {
    discrepancies.push("Reconciled filled quantity decreased after the order was accepted.");
  }
  if (observed.executedQty > approvedQuantity) {
    discrepancies.push("Reconciled filled quantity exceeds the approved quantity.");
  }
  if (inconsistentFill(expected, approvedQuantity)) {
    discrepancies.push("Accepted order status is inconsistent with its fill.");
  }
  if (inconsistentFill(observed, approvedQuantity)) {
    discrepancies.push("Reconciled order status is inconsistent with its fill.");
  }
  if (observed.executedQty === expected.executedQty && observed.avgPrice !== expected.avgPrice) {
    discrepancies.push("Reconciled average price changed without an additional fill.");
  }
  if (observed.executedQty > 0) {
    if (observed.avgPrice <= 0) {
      discrepancies.push("Reconciled fill is missing an execution price.");
    } else if (observed.side === "BUY" && observed.avgPrice > approvedPrice) {
      discrepancies.push("Reconciled buy price exceeds the approved limit.");
    } else if (observed.side === "SELL" && observed.avgPrice < approvedPrice) {
      discrepancies.push("Reconciled sell price is below the approved limit.");
    }
  }
  return discrepancies;
}

function inconsistentFill(order: BrokerOrderStatus, approvedQuantity: number): boolean {
  if (order.executedQty === 0 && order.avgPrice !== 0) return true;
  if (order.status === "FILLED") return order.executedQty !== approvedQuantity;
  if (order.status === "PARTIALLY_FILLED") {
    return order.executedQty <= 0 || order.executedQty >= approvedQuantity;
  }
  return (
    (order.status === "NEW" || order.status === "PENDING_NEW" || order.status === "REJECTED") &&
    order.executedQty !== 0
  );
}

function isLegalTransition(from: string, to: string): boolean {
  if (!Object.hasOwn(LEGAL_TRANSITIONS, from)) return false;
  const allowed = LEGAL_TRANSITIONS[from];
  return Object.hasOwn(allowed, to);
}
