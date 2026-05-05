import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEventType, Environment } from "@guardrails/schemas";
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
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
    const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");
    this.baselineLegacySchema(sqlite, migrationsFolder);
    migrate(this.db, { migrationsFolder });
  }

  private baselineLegacySchema(sqlite: Database.Database, migrationsFolder: string) {
    if (!this.tableExists(sqlite, "audit_events")) {
      return;
    }

    const baselineMigration = [...readMigrationFiles({ migrationsFolder })].sort(
      (left, right) => left.folderMillis - right.folderMillis,
    )[0];
    if (!baselineMigration) return;

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

    sqlite
      .prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS audit_events_event_id_unique ON audit_events (event_id)",
      )
      .run();
    this.ensureMigrationTable(sqlite);

    const existingBaseline = sqlite
      .prepare("SELECT id FROM __drizzle_migrations WHERE hash = ? AND created_at = ?")
      .get(baselineMigration.hash, baselineMigration.folderMillis);
    if (!existingBaseline) {
      sqlite
        .prepare('INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)')
        .run(baselineMigration.hash, baselineMigration.folderMillis);
    }
  }

  private ensureMigrationTable(sqlite: Database.Database) {
    sqlite
      .prepare(`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `)
      .run();

    const columns = sqlite.prepare("PRAGMA table_info(__drizzle_migrations)").all() as Array<{
      name: string;
    }>;
    const existingColumns = new Set(columns.map((column) => column.name));
    for (const [column, definition] of [
      ["id", "SERIAL"],
      ["hash", "text"],
      ["created_at", "numeric"],
    ] as const) {
      if (!existingColumns.has(column)) {
        sqlite.prepare(`ALTER TABLE __drizzle_migrations ADD COLUMN ${column} ${definition}`).run();
      }
    }
  }

  private tableExists(sqlite: Database.Database, tableName: string): boolean {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName);
    return row != null;
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
