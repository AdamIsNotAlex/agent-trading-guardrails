import { createHash, randomUUID } from "node:crypto";
import type { AuditEventType, Environment } from "@guardrails/schemas";
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { auditEvents } from "./schema.js";

export interface AuditEventInput {
  eventType: AuditEventType;
  environment: Environment;
  correlationId: string;
  intentId?: string;
  principal?: string;
  promptId?: string;
  sessionId?: string;
  inputRef?: string;
  data: Record<string, unknown>;
}

export class AuditWriter {
  private db;
  private lastHash = "0".repeat(64);

  constructor(sqlite: Database.Database) {
    this.db = drizzle(sqlite);
    this.initSchema(sqlite);
    this.recoverLastHash();
  }

  private initSchema(sqlite: Database.Database) {
    const createTableSql = `
      CREATE TABLE IF NOT EXISTS audit_events (
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
    `;
    sqlite.prepare(createTableSql).run();
    const columns = sqlite.prepare("PRAGMA table_info(audit_events)").all() as Array<{
      name: string;
    }>;
    const existingColumns = new Set(columns.map((column) => column.name));
    for (const [column, definition] of [
      ["prompt_id", "TEXT"],
      ["session_id", "TEXT"],
      ["input_ref", "TEXT"],
    ] as const) {
      if (!existingColumns.has(column)) {
        sqlite.prepare(`ALTER TABLE audit_events ADD COLUMN ${column} ${definition}`).run();
      }
    }
  }

  private recoverLastHash() {
    const rows = this.db
      .select({ previousHash: auditEvents.previousHash })
      .from(auditEvents)
      .orderBy(auditEvents.id)
      .all();
    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      this.lastHash = this.computeHash(last.previousHash, "recovered");
    }
  }

  write(event: AuditEventInput): void {
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();
    const dataJson = JSON.stringify(event.data);
    const previousHash = this.lastHash;

    this.db
      .insert(auditEvents)
      .values({
        eventId,
        eventType: event.eventType,
        timestamp,
        correlationId: event.correlationId,
        environment: event.environment,
        intentId: event.intentId ?? null,
        principal: event.principal ?? null,
        promptId: event.promptId ?? null,
        sessionId: event.sessionId ?? null,
        inputRef: event.inputRef ?? null,
        data: dataJson,
        previousHash,
      })
      .run();

    this.lastHash = this.computeHash(previousHash, `${eventId}:${timestamp}:${dataJson}`);
  }

  getLastHash(): string {
    return this.lastHash;
  }

  private computeHash(previousHash: string, content: string): string {
    return createHash("sha256").update(previousHash).update(content).digest("hex");
  }
}
