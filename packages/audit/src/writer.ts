import { createHmac, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEventType, Environment } from "@guardrails/schemas";
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { auditEvents } from "./schema.js";

export interface AuditEventInput {
  eventId?: string;
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

export interface AuditWriterOptions {
  environment: Environment;
  hashSecret?: string;
  hashAnchorPath?: string;
  repairHashAnchor?: boolean;
}

export class AuditWriter {
  private db;
  private lastHash = "0".repeat(64);
  private pendingAnchorRepairHash?: string;
  private hashSecret: string;
  private hashAnchorPath?: string;

  constructor(
    private sqlite: Database.Database,
    options: AuditWriterOptions,
  ) {
    this.hashSecret =
      options.hashSecret ?? process.env.AUDIT_HASH_SECRET ?? "dev-audit-hash-secret";
    this.hashAnchorPath = options.hashAnchorPath ?? process.env.AUDIT_HASH_ANCHOR_PATH;
    assertAuditHashSecret(options.environment, this.hashSecret);
    assertAuditHashAnchor(options.environment, this.hashAnchorPath);
    this.db = drizzle(sqlite);
    this.initSchema(sqlite);
    this.recoverLastHash();
    this.verifyAnchoredHash(options.repairHashAnchor ?? false);
  }

  private initSchema(sqlite: Database.Database) {
    const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");
    this.baselineLegacySchema(sqlite, migrationsFolder);
    migrate(this.db, { migrationsFolder });
    this.ensureAuditEventColumns(sqlite);
    this.backfillLegacyEventHashes(sqlite);
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

  private ensureAuditEventColumns(sqlite: Database.Database) {
    const columns = sqlite.prepare("PRAGMA table_info(audit_events)").all() as Array<{
      name: string;
    }>;
    const existingColumns = new Set(columns.map((column) => column.name));
    for (const [column, definition] of [
      ["prompt_id", "TEXT"],
      ["session_id", "TEXT"],
      ["input_ref", "TEXT"],
      ["event_hash", "TEXT"],
    ] as const) {
      if (!existingColumns.has(column)) {
        sqlite.prepare(`ALTER TABLE audit_events ADD COLUMN ${column} ${definition}`).run();
      }
    }
  }

  private backfillLegacyEventHashes(sqlite: Database.Database) {
    const rows = sqlite.prepare("SELECT * FROM audit_events ORDER BY id").all() as Array<{
      id: number;
      event_id: string;
      event_type: string;
      timestamp: string;
      correlation_id: string;
      environment: string;
      intent_id: string | null;
      principal: string | null;
      prompt_id: string | null;
      session_id: string | null;
      input_ref: string | null;
      data: string;
      previous_hash: string;
      event_hash: string | null;
    }>;
    if (rows.length === 0 || rows.every((row) => row.event_hash != null)) return;
    if (rows.some((row) => row.event_hash != null)) {
      throw new Error("Audit event hash chain cannot mix legacy and sealed rows.");
    }

    let previousHash = "0".repeat(64);
    const update = sqlite.prepare(
      "UPDATE audit_events SET previous_hash = ?, event_hash = ? WHERE id = ?",
    );
    for (const row of rows) {
      const eventHash = this.computeEventHash({
        eventId: row.event_id,
        eventType: row.event_type,
        timestamp: row.timestamp,
        correlationId: row.correlation_id,
        environment: row.environment,
        intentId: row.intent_id,
        principal: row.principal,
        promptId: row.prompt_id,
        sessionId: row.session_id,
        inputRef: row.input_ref,
        data: row.data,
        previousHash,
      });
      update.run(previousHash, eventHash, row.id);
      previousHash = eventHash;
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
    const rows = this.db.select().from(auditEvents).orderBy(auditEvents.id).all();
    let previousHash = "0".repeat(64);
    for (const row of rows) {
      if (row.previousHash !== previousHash) {
        throw new Error("Audit hash chain is broken.");
      }
      if (!row.eventHash) {
        throw new Error("Audit event hash is missing.");
      }
      const eventHash = this.computeEventHash(row);
      if (row.eventHash !== eventHash) {
        throw new Error("Audit event hash mismatch.");
      }
      previousHash = eventHash;
    }
    this.lastHash = previousHash;
  }

  write(event: AuditEventInput): void {
    let committedHash: string | undefined;
    this.sqlite
      .transaction(() => {
        this.recoverLastHash();
        const eventId = event.eventId ?? randomUUID();
        const timestamp = new Date().toISOString();
        const redactedEvent = redactObject(event) as AuditEventInput;
        const dataJson = JSON.stringify(redactedEvent.data);
        const existing = this.sqlite
          .prepare(
            `SELECT event_type, correlation_id, environment, intent_id, principal, prompt_id, session_id, input_ref, data, event_hash
             FROM audit_events WHERE event_id = ? LIMIT 1`,
          )
          .get(eventId) as
          | {
              event_type: string;
              correlation_id: string;
              environment: string;
              intent_id: string | null;
              principal: string | null;
              prompt_id: string | null;
              session_id: string | null;
              input_ref: string | null;
              data: string;
              event_hash: string;
            }
          | undefined;
        if (existing) {
          if (
            existing.event_type !== redactedEvent.eventType ||
            existing.correlation_id !== redactedEvent.correlationId ||
            existing.environment !== redactedEvent.environment ||
            existing.intent_id !== (redactedEvent.intentId ?? null) ||
            existing.principal !== (redactedEvent.principal ?? null) ||
            existing.prompt_id !== (redactedEvent.promptId ?? null) ||
            existing.session_id !== (redactedEvent.sessionId ?? null) ||
            existing.input_ref !== (redactedEvent.inputRef ?? null) ||
            existing.data !== dataJson
          ) {
            throw new Error("Audit event id already exists with different content.");
          }
          if (existing.event_hash !== this.lastHash) {
            this.verifyAnchoredHash(false);
            return;
          }
          if (this.pendingAnchorRepairHash !== this.lastHash) {
            this.verifyAnchoredHash(false);
            return;
          }
          committedHash = this.lastHash;
          return;
        }
        this.verifyAnchoredHash(false);
        const previousHash = this.lastHash;
        const row = {
          eventId,
          eventType: redactedEvent.eventType,
          timestamp,
          correlationId: redactedEvent.correlationId,
          environment: redactedEvent.environment,
          intentId: redactedEvent.intentId ?? null,
          principal: redactedEvent.principal ?? null,
          promptId: redactedEvent.promptId ?? null,
          sessionId: redactedEvent.sessionId ?? null,
          inputRef: redactedEvent.inputRef ?? null,
          data: dataJson,
          previousHash,
        };
        const eventHash = this.computeEventHash(row);

        this.db
          .insert(auditEvents)
          .values({
            ...row,
            eventHash,
          })
          .run();

        this.lastHash = eventHash;
        committedHash = eventHash;
      })
      .immediate();

    try {
      this.writeAnchoredHash(committedHash);
      if (committedHash && this.pendingAnchorRepairHash === committedHash) {
        this.pendingAnchorRepairHash = undefined;
      }
    } catch (err) {
      if (committedHash) this.pendingAnchorRepairHash = committedHash;
      throw err;
    }
  }

  getLastHash(): string {
    return this.lastHash;
  }

  private verifyAnchoredHash(repair: boolean): void {
    if (!this.hashAnchorPath) return;
    if (!existsSync(this.hashAnchorPath)) {
      if (this.lastHash !== "0".repeat(64)) {
        if (repair) {
          this.writeAnchoredHash(this.lastHash);
          return;
        }
        throw new Error("Audit hash anchor is missing for a non-empty hash chain.");
      }
      return;
    }
    const anchoredHash = readFileSync(this.hashAnchorPath, "utf8").trim();
    if (anchoredHash !== this.lastHash) {
      if (repair) {
        this.writeAnchoredHash(this.lastHash);
        return;
      }
      throw new Error("Audit hash anchor does not match the recovered hash chain.");
    }
  }

  private writeAnchoredHash(hash: string | undefined): void {
    if (!this.hashAnchorPath || !hash) return;

    const tempPath = `${this.hashAnchorPath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, "w", 0o600);
      writeFileSync(fd, `${hash}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tempPath, this.hashAnchorPath);
      const dirFd = openSync(dirname(this.hashAnchorPath), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (err) {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(tempPath)) unlinkSync(tempPath);
      throw err;
    }
  }

  private computeEventHash(row: {
    eventId: string;
    eventType: string;
    timestamp: string;
    correlationId: string;
    environment: string;
    intentId: string | null;
    principal: string | null;
    promptId: string | null;
    sessionId: string | null;
    inputRef: string | null;
    data: string;
    previousHash: string;
  }): string {
    return this.computeHash(
      row.previousHash,
      JSON.stringify({
        eventId: row.eventId,
        eventType: row.eventType,
        timestamp: row.timestamp,
        correlationId: row.correlationId,
        environment: row.environment,
        intentId: row.intentId,
        principal: row.principal,
        promptId: row.promptId,
        sessionId: row.sessionId,
        inputRef: row.inputRef,
        data: row.data,
      }),
    );
  }

  private computeHash(previousHash: string, content: string): string {
    return createHmac("sha256", this.hashSecret).update(previousHash).update(content).digest("hex");
  }
}

function assertAuditHashSecret(environment: string, secret: string): void {
  if (environment === "dev" || environment === "test") return;
  if (secret === "dev-audit-hash-secret" || secret.length < 32) {
    throw new Error(
      "Audit hash secret must be configured with at least 32 characters outside dev.",
    );
  }
}

function assertAuditHashAnchor(environment: string, hashAnchorPath: string | undefined): void {
  if (environment === "dev" || environment === "test") return;
  if (!hashAnchorPath) {
    throw new Error("Audit hash anchor path must be configured outside dev.");
  }
}

function redactObject(obj: unknown): unknown {
  if (typeof obj === "string") return redactSecrets(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = isSecretKey(key) ? "[REDACTED]" : redactObject(value);
    }
    return result;
  }
  return obj;
}

function redactSecrets(text: string): string {
  return text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      "[REDACTED]",
    )
    .replace(/\b((?:key|private key|secret key)\s+is\s+)0x[0-9a-f]{64}\b/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|api[_-]?secret|private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|vault[_-]?token)\s*[:=]\s*)([^\r\n,}]+)/gi,
      "$1[REDACTED]",
    );
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    normalized.includes("secret") ||
    normalized.includes("private") ||
    normalized.includes("mnemonic") ||
    normalized.includes("seed") ||
    normalized === "token" ||
    ["vaulttoken", "accesstoken", "refreshtoken", "authtoken", "bearertoken"].some((suffix) =>
      normalized.endsWith(suffix),
    ) ||
    normalized === "authorization" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("apisecret")
  );
}
