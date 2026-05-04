import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AuditWriter } from "./writer.js";

function createTestDb() {
  return new Database(":memory:");
}

describe("AuditWriter", () => {
  it("writes and retrieves audit events", () => {
    const writer = new AuditWriter(createTestDb());
    writer.write({
      eventType: "intent.received",
      environment: "dev",
      correlationId: "corr-001",
      intentId: "intent-001",
      principal: "agent.test",
      data: { action: "cex.place_order", resource: "cex:binance:sub:ETH" },
    });

    const db = createTestDb();
    const writer2 = new AuditWriter(db);
    writer2.write({
      eventType: "intent.received",
      environment: "dev",
      correlationId: "corr-002",
      data: { test: true },
    });
    const rows = db.prepare("SELECT * FROM audit_events").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("intent.received");
    expect(rows[0].correlation_id).toBe("corr-002");
  });

  it("includes agent identity in events", () => {
    const db = createTestDb();
    const writer = new AuditWriter(db);
    writer.write({
      eventType: "intent.received",
      environment: "dev",
      correlationId: "corr-001",
      principal: "agent.openclaw.alpha",
      data: {},
    });
    const row = db.prepare("SELECT principal FROM audit_events").get() as Record<string, unknown>;
    expect(row.principal).toBe("agent.openclaw.alpha");
  });

  it("includes intent ID in events", () => {
    const db = createTestDb();
    const writer = new AuditWriter(db);
    writer.write({
      eventType: "reviewer.completed",
      environment: "canary_live",
      correlationId: "corr-001",
      intentId: "intent-123",
      data: { verdict: "approve" },
    });
    const row = db.prepare("SELECT intent_id FROM audit_events").get() as Record<string, unknown>;
    expect(row.intent_id).toBe("intent-123");
  });

  it("stores structured data as JSON", () => {
    const db = createTestDb();
    const writer = new AuditWriter(db);
    const testData = {
      intent: { action: "cex.place_order", symbol: "ETH-USDC" },
      reviewerVerdict: "approve",
      riskChecks: [{ check: "freshness", status: "pass" }],
      orderId: "order-456",
    };
    writer.write({
      eventType: "broker.executed",
      environment: "paper",
      correlationId: "corr-001",
      data: testData,
    });
    const row = db.prepare("SELECT data FROM audit_events").get() as Record<string, unknown>;
    const parsed = JSON.parse(row.data as string);
    expect(parsed.intent.action).toBe("cex.place_order");
    expect(parsed.reviewerVerdict).toBe("approve");
    expect(parsed.orderId).toBe("order-456");
  });

  it("maintains hash chain across events", () => {
    const db = createTestDb();
    const writer = new AuditWriter(db);

    writer.write({
      eventType: "intent.received",
      environment: "dev",
      correlationId: "c1",
      data: {},
    });
    const hash1 = writer.getLastHash();

    writer.write({
      eventType: "reviewer.completed",
      environment: "dev",
      correlationId: "c2",
      data: {},
    });
    const hash2 = writer.getLastHash();

    writer.write({
      eventType: "broker.executed",
      environment: "dev",
      correlationId: "c3",
      data: {},
    });
    const hash3 = writer.getLastHash();

    expect(hash1).not.toBe(hash2);
    expect(hash2).not.toBe(hash3);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);

    const rows = db.prepare("SELECT previous_hash FROM audit_events ORDER BY id").all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(3);
    expect(rows[0].previous_hash).toBe("0".repeat(64));
    expect(rows[1].previous_hash).not.toBe(rows[0].previous_hash);
  });

  it("creates schema from empty database", () => {
    const db = createTestDb();
    new AuditWriter(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<
      Record<string, unknown>
    >;
    expect(tables.some((t) => t.name === "audit_events")).toBe(true);
  });

  it("records complete allow flow", () => {
    const db = createTestDb();
    const writer = new AuditWriter(db);
    const corr = "allow-flow-001";
    writer.write({
      eventType: "intent.received",
      environment: "dev",
      correlationId: corr,
      intentId: "i1",
      data: {},
    });
    writer.write({
      eventType: "intent.validated",
      environment: "dev",
      correlationId: corr,
      intentId: "i1",
      data: {},
    });
    writer.write({
      eventType: "reviewer.completed",
      environment: "dev",
      correlationId: corr,
      intentId: "i1",
      data: { verdict: "approve" },
    });
    writer.write({
      eventType: "policy.evaluated",
      environment: "dev",
      correlationId: corr,
      intentId: "i1",
      data: { decision: "allow" },
    });
    writer.write({
      eventType: "risk.evaluated",
      environment: "dev",
      correlationId: corr,
      intentId: "i1",
      data: { passed: true },
    });
    writer.write({
      eventType: "broker.executed",
      environment: "dev",
      correlationId: corr,
      intentId: "i1",
      data: { orderId: "o1" },
    });
    const rows = db
      .prepare("SELECT event_type FROM audit_events WHERE correlation_id = ?")
      .all(corr) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
  });

  it("records complete deny flow", () => {
    const db = createTestDb();
    const writer = new AuditWriter(db);
    const corr = "deny-flow-001";
    writer.write({
      eventType: "intent.received",
      environment: "dev",
      correlationId: corr,
      intentId: "i2",
      data: {},
    });
    writer.write({
      eventType: "intent.rejected",
      environment: "dev",
      correlationId: corr,
      intentId: "i2",
      data: { reason: "invalid" },
    });
    const rows = db
      .prepare("SELECT event_type FROM audit_events WHERE correlation_id = ?")
      .all(corr) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
  });

  it("records needs-human flow", () => {
    const db = createTestDb();
    const writer = new AuditWriter(db);
    const corr = "human-flow-001";
    writer.write({
      eventType: "intent.received",
      environment: "dev",
      correlationId: corr,
      data: {},
    });
    writer.write({
      eventType: "reviewer.completed",
      environment: "dev",
      correlationId: corr,
      data: { verdict: "needs_human" },
    });
    writer.write({
      eventType: "policy.evaluated",
      environment: "dev",
      correlationId: corr,
      data: { decision: "needs_human" },
    });
    writer.write({
      eventType: "approval.created",
      environment: "dev",
      correlationId: corr,
      data: {},
    });
    const rows = db
      .prepare("SELECT event_type FROM audit_events WHERE correlation_id = ?")
      .all(corr) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4);
  });

  it("records error flow", () => {
    const db = createTestDb();
    const writer = new AuditWriter(db);
    const corr = "error-flow-001";
    writer.write({
      eventType: "intent.received",
      environment: "dev",
      correlationId: corr,
      data: {},
    });
    writer.write({
      eventType: "reviewer.failed",
      environment: "dev",
      correlationId: corr,
      data: { error: "timeout" },
    });
    const rows = db
      .prepare("SELECT event_type FROM audit_events WHERE correlation_id = ?")
      .all(corr) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
  });
});
