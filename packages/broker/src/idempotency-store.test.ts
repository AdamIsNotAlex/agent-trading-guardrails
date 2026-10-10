import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrokerExecutionResult,
  BrokerOrderReconciliation,
  TradingIntent,
} from "@guardrails/schemas";
import { binanceSpotOrder as canarySpotOrder } from "@guardrails/schemas/fixtures";
import { describe, expect, it } from "vitest";
import { FileBrokerIdempotencyStore } from "./idempotency-store.js";
import type { BrokerAuditEvent } from "./interfaces.js";

const intent: TradingIntent = { ...canarySpotOrder, environment: "testnet" };

function terminalAuditEventId(
  tradingIntent: TradingIntent,
  correlationId: string,
  eventType: "broker.executed" | "broker.failed",
) {
  const hash = createHash("sha256")
    .update(
      `${eventType}:${tradingIntent.intentId}:${tradingIntent.idempotencyKey}:${tradingIntent.principal}:${tradingIntent.action}:${tradingIntent.resource}:${correlationId}`,
    )
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function executedResult(
  reconciliation: BrokerOrderReconciliation,
): Extract<BrokerExecutionResult, { executionKind: "cex_order" }> {
  return {
    intentId: intent.intentId,
    idempotencyKey: intent.idempotencyKey,
    status: "executed",
    executionKind: "cex_order",
    orderId: "order-42",
    orderStatus: reconciliation.expected,
    revalidationPassed: true,
    executedAt: "2026-05-04T12:00:04.000Z",
    reconciliation,
  };
}

function pendingExecutedAudit(result: BrokerExecutionResult): BrokerAuditEvent {
  const event: BrokerAuditEvent = {
    eventId: terminalAuditEventId(intent, "corr-001", "broker.executed"),
    eventType: "broker.executed",
    environment: intent.environment,
    intentId: intent.intentId,
    principal: intent.principal,
    correlationId: "corr-001",
    data: {
      status: result.status,
      orderId: "orderId" in result ? result.orderId : undefined,
      orderStatus: "orderStatus" in result ? result.orderStatus : undefined,
      reconciliation: "reconciliation" in result ? result.reconciliation : undefined,
    },
  };
  event.data = Object.fromEntries(
    Object.entries(event.data).filter(([, value]) => value !== undefined),
  );
  return event;
}

describe("FileBrokerIdempotencyStore reconciliation recovery", () => {
  it("replays a discrepancy without resubmitting the accepted order", () => {
    const dir = mkdtempSync(join(tmpdir(), "idempotency-reconciliation-"));
    try {
      const path = join(dir, "store.json");
      const firstStore = new FileBrokerIdempotencyStore(path);
      const reservation = firstStore.begin(intent.idempotencyKey, intent);
      if (reservation.status !== "reserved")
        throw new Error("Expected reserved idempotency entry.");

      const expected = {
        orderId: "order-42",
        symbol: "ETH-USDC",
        side: "BUY",
        status: "FILLED",
        executedQty: 0.002,
        avgPrice: 3500,
      };
      const result = executedResult({
        status: "discrepancy",
        checkedAt: "2026-05-04T12:00:05.000Z",
        expected,
        observed: { ...expected, executedQty: 0.003, avgPrice: 3490 },
        discrepancies: ["executed quantity exceeded the approved size"],
      });
      const pendingAudit = pendingExecutedAudit(result);
      reservation.complete(result, pendingAudit);

      const recovered = new FileBrokerIdempotencyStore(path).begin(intent.idempotencyKey, intent);
      expect(recovered.status).toBe("cached");
      if (recovered.status !== "cached") throw new Error("Expected cached recovery.");
      expect(recovered.result).toEqual(result);
      expect(recovered.pendingAudit?.data.reconciliation).toEqual(result.reconciliation);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays unavailable reconciliation after a failed terminal audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "idempotency-unavailable-"));
    try {
      const path = join(dir, "store.json");
      const firstStore = new FileBrokerIdempotencyStore(path);
      const reservation = firstStore.begin(intent.idempotencyKey, intent);
      if (reservation.status !== "reserved")
        throw new Error("Expected reserved idempotency entry.");

      const expected = {
        orderId: "order-42",
        symbol: "ETH-USDC",
        side: "BUY",
        status: "NEW",
        executedQty: 0,
        avgPrice: 0,
      };
      const result = executedResult({
        status: "unavailable",
        checkedAt: "2026-05-04T12:00:05.000Z",
        expected,
        discrepancies: ["Order status could not be queried."],
      });
      reservation.complete(result, pendingExecutedAudit(result));

      const recovered = new FileBrokerIdempotencyStore(path).begin(intent.idempotencyKey, intent);
      expect(recovered.status).toBe("cached");
      if (recovered.status !== "cached") throw new Error("Expected cached recovery.");
      expect(recovered.result).toMatchObject({
        status: "executed",
        orderId: "order-42",
        reconciliation: { status: "unavailable" },
      });
      expect(recovered.pendingAudit?.eventType).toBe("broker.executed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects pending audit recovery when reconciliation is dropped from the audit payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "idempotency-reconciliation-mismatch-"));
    try {
      const path = join(dir, "store.json");
      const firstStore = new FileBrokerIdempotencyStore(path);
      const reservation = firstStore.begin(intent.idempotencyKey, intent);
      if (reservation.status !== "reserved")
        throw new Error("Expected reserved idempotency entry.");

      const expected = {
        orderId: "order-42",
        symbol: "ETH-USDC",
        side: "BUY",
        status: "FILLED",
        executedQty: 0.002,
        avgPrice: 3500,
      };
      const result = executedResult({
        status: "matched",
        checkedAt: "2026-05-04T12:00:05.000Z",
        expected,
        observed: expected,
        discrepancies: [],
      });
      const pendingAudit = pendingExecutedAudit(result);
      delete pendingAudit.data.reconciliation;
      reservation.complete(result, pendingAudit);

      expect(() =>
        new FileBrokerIdempotencyStore(path).begin(intent.idempotencyKey, intent),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
