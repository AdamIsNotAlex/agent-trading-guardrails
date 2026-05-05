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

  it("includes prompt, session, and input references in events", () => {
    const db = createTestDb();
    const writer = new AuditWriter(db);
    writer.write({
      eventType: "intent.received",
      environment: "canary_live",
      correlationId: "corr-001",
      intentId: "intent-123",
      promptId: "prompt-123",
      sessionId: "session-456",
      inputRef: "evidence://input-789",
      data: { intent: { action: "cex.place_order" } },
    });
    const row = db
      .prepare("SELECT prompt_id, session_id, input_ref FROM audit_events")
      .get() as Record<string, unknown>;
    expect(row.prompt_id).toBe("prompt-123");
    expect(row.session_id).toBe("session-456");
    expect(row.input_ref).toBe("evidence://input-789");
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

  it("applies Drizzle migrations from an empty database", () => {
    const db = createTestDb();
    new AuditWriter(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<
      Record<string, unknown>
    >;
    const columns = db.prepare("PRAGMA table_info(audit_events)").all() as Array<
      Record<string, unknown>
    >;
    const columnNames = columns.map((column) => column.name);

    expect(tables.some((table) => table.name === "audit_events")).toBe(true);
    expect(columnNames).toEqual([
      "id",
      "event_id",
      "event_type",
      "timestamp",
      "correlation_id",
      "environment",
      "intent_id",
      "principal",
      "prompt_id",
      "session_id",
      "input_ref",
      "data",
      "previous_hash",
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toMatchObject({
      count: 1,
    });
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("audit_events_event_id_unique"),
    ).toMatchObject({ name: "audit_events_event_id_unique" });
  });

  it("baselines legacy audit tables before applying Drizzle migrations", () => {
    const db = createTestDb();
    db.prepare(`
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        intent_id TEXT,
        principal TEXT,
        data TEXT NOT NULL,
        previous_hash TEXT NOT NULL
      )
    `).run();

    const writer = new AuditWriter(db);
    writer.write({
      eventType: "intent.received",
      environment: "dev",
      correlationId: "corr-001",
      promptId: "prompt-123",
      sessionId: "session-123",
      inputRef: "input-123",
      data: {},
    });

    const row = db
      .prepare("SELECT prompt_id, session_id, input_ref FROM audit_events")
      .get() as Record<string, unknown>;
    expect(row.prompt_id).toBe("prompt-123");
    expect(row.session_id).toBe("session-123");
    expect(row.input_ref).toBe("input-123");
    expect(db.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toMatchObject({
      count: 1,
    });
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("audit_events_event_id_unique"),
    ).toMatchObject({ name: "audit_events_event_id_unique" });
  });

  it("baselines legacy audit tables with empty migration metadata", () => {
    const db = createTestDb();
    db.prepare(`
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        intent_id TEXT,
        principal TEXT,
        prompt_id TEXT,
        session_id TEXT,
        input_ref TEXT,
        data TEXT NOT NULL,
        previous_hash TEXT NOT NULL
      )
    `).run();
    db.prepare(`
      CREATE TABLE __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `).run();

    new AuditWriter(db);

    expect(db.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toMatchObject({
      count: 1,
    });
  });

  it("repairs legacy migration metadata tables with missing columns", () => {
    const db = createTestDb();
    db.prepare(`
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        intent_id TEXT,
        principal TEXT,
        prompt_id TEXT,
        session_id TEXT,
        input_ref TEXT,
        data TEXT NOT NULL,
        previous_hash TEXT NOT NULL
      )
    `).run();
    db.prepare("CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY)").run();

    new AuditWriter(db);

    expect(db.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toMatchObject({
      count: 1,
    });
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
      data: { reviewerVerdict: { verdict: "approve" } },
    });
    writer.write({
      eventType: "policy.evaluated",
      environment: "dev",
      correlationId: corr,
      intentId: "i1",
      data: { decision: "allow", opaInput: { action: "cex.place_order" } },
    });
    writer.write({
      eventType: "risk.evaluated",
      environment: "dev",
      correlationId: corr,
      intentId: "i1",
      data: { passed: true, riskChecks: [{ check: "freshness", status: "pass" }] },
    });
    writer.write({
      eventType: "broker.executed",
      environment: "dev",
      correlationId: corr,
      intentId: "i1",
      data: { orderId: "o1" },
    });
    const rows = db
      .prepare("SELECT event_type, data FROM audit_events WHERE correlation_id = ?")
      .all(corr) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    const reviewerEvent = rows.find((row) => row.event_type === "reviewer.completed");
    const policyEvent = rows.find((row) => row.event_type === "policy.evaluated");
    const riskEvent = rows.find((row) => row.event_type === "risk.evaluated");
    expect(JSON.parse(reviewerEvent?.data as string).reviewerVerdict).toMatchObject({
      verdict: "approve",
    });
    expect(JSON.parse(policyEvent?.data as string).opaInput).toMatchObject({
      action: "cex.place_order",
    });
    expect(JSON.parse(riskEvent?.data as string).riskChecks).toEqual([
      { check: "freshness", status: "pass" },
    ]);
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
      eventType: "approval.requested",
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
