import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { BrokerExecutionResult, TradingIntent } from "@guardrails/schemas";
import {
  type BrokerAuditEvent,
  type BrokerIdempotencyReservation,
  type BrokerIdempotencyStore,
  IdempotencyConflictError,
} from "./interfaces.js";

export interface InMemoryBrokerIdempotencyStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

interface CachedEntry {
  status: "cached";
  payloadHash: string;
  result: BrokerExecutionResult;
  pendingAudit?: BrokerAuditEvent;
  expiresAt?: number;
  completePending?(result: BrokerExecutionResult): void;
  abortPending?(error: unknown): void;
}

interface PendingEntry {
  status: "pending";
  payloadHash: string;
  result: Promise<BrokerExecutionResult>;
  complete(result: BrokerExecutionResult, pendingAudit?: BrokerAuditEvent): void;
  abort(error: unknown): void;
}

type IdempotencyEntry = CachedEntry | PendingEntry;

export class InMemoryBrokerIdempotencyStore implements BrokerIdempotencyStore {
  private entries = new Map<string, IdempotencyEntry>();
  private now: () => number;

  constructor(private options: InMemoryBrokerIdempotencyStoreOptions = {}) {
    if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
      throw new Error("Idempotency TTL must be a positive finite number of milliseconds.");
    }
    this.now = options.now ?? Date.now;
  }

  begin(key: string, intent: TradingIntent): BrokerIdempotencyReservation {
    this.pruneExpired();

    const scopedKey = scopeIdempotencyKey(key, intent);
    const payloadHash = hashIntentPayload(intent);
    const entry = this.entries.get(scopedKey);
    if (entry) {
      this.assertPayloadMatches(key, entry, payloadHash);
      if (entry.status === "cached") {
        return {
          status: "cached",
          result: entry.result,
          pendingAudit: entry.pendingAudit,
          completeAudit: () => {
            const current = this.entries.get(scopedKey);
            if (current?.status === "cached" && current.payloadHash === payloadHash) {
              current.pendingAudit = undefined;
              current.completePending?.(current.result);
              current.completePending = undefined;
              current.abortPending = undefined;
            }
          },
        };
      }
      return { status: "pending", result: entry.result };
    }

    let complete: (result: BrokerExecutionResult) => void = () => {};
    let abort: (error: unknown) => void = () => {};
    const pendingResult = new Promise<BrokerExecutionResult>((resolve, reject) => {
      complete = resolve;
      abort = reject;
    });
    pendingResult.catch(() => {});
    this.entries.set(scopedKey, {
      status: "pending",
      payloadHash,
      result: pendingResult,
      complete: (result, pendingAudit) => {
        this.entries.set(scopedKey, {
          status: "cached",
          payloadHash,
          result,
          pendingAudit,
          expiresAt: this.options.ttlMs === undefined ? undefined : this.now() + this.options.ttlMs,
          completePending: complete,
          abortPending: abort,
        });
        if (!pendingAudit) complete(result);
      },
      abort: (error) => {
        this.entries.delete(scopedKey);
        abort(error);
      },
    });

    return {
      status: "reserved",
      complete: (result, pendingAudit) => {
        const current = this.entries.get(scopedKey);
        if (current?.status === "pending" && current.payloadHash === payloadHash) {
          current.complete(result, pendingAudit);
        }
      },
      completeAudit: () => {
        const current = this.entries.get(scopedKey);
        if (current?.status === "cached" && current.payloadHash === payloadHash) {
          current.pendingAudit = undefined;
          current.completePending?.(current.result);
          current.completePending = undefined;
          current.abortPending = undefined;
        }
      },
      failAudit: (error) => {
        const current = this.entries.get(scopedKey);
        if (current?.status === "cached" && current.payloadHash === payloadHash) {
          current.abortPending?.(error);
          current.completePending = undefined;
          current.abortPending = undefined;
        }
      },
      abort: (error) => {
        const current = this.entries.get(scopedKey);
        if (current?.status === "pending" && current.payloadHash === payloadHash) {
          current.abort(error);
        }
      },
    };
  }

  private pruneExpired(): void {}

  private assertPayloadMatches(key: string, entry: IdempotencyEntry, payloadHash: string): void {
    if (entry.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError(key);
    }
  }
}

export interface FileBrokerIdempotencyStoreOptions {
  now?: () => number;
}

type FileEntry =
  | {
      status: "cached";
      payloadHash: string;
      result: BrokerExecutionResult;
      pendingAudit?: BrokerAuditEvent;
    }
  | {
      status: "in_progress";
      payloadHash: string;
    };

interface FileState {
  entries: Record<string, FileEntry>;
}

const fileLockTimeoutMs = 1_000;
const staleFileLockMs = 30_000;

export class FileBrokerIdempotencyStore implements BrokerIdempotencyStore {
  private pending = new Map<
    string,
    {
      payloadHash: string;
      result: Promise<BrokerExecutionResult>;
      complete(result: BrokerExecutionResult, pendingAudit?: BrokerAuditEvent): void;
      abort(error: unknown): void;
    }
  >();
  constructor(
    private path: string,
    _options: FileBrokerIdempotencyStoreOptions = {},
  ) {}

  begin(key: string, intent: TradingIntent): BrokerIdempotencyReservation {
    const scopedKey = scopeIdempotencyKey(key, intent);
    const payloadHash = hashIntentPayload(intent);

    const pending = this.pending.get(scopedKey);
    if (pending) {
      this.assertPayloadMatches(key, pending, payloadHash);
      return { status: "pending", result: pending.result };
    }

    const existing = this.withLockedState((state) => {
      const entry = state.entries[scopedKey];
      if (entry) return entry;

      state.entries[scopedKey] = {
        status: "in_progress",
        payloadHash,
      };
      return undefined;
    });

    if (existing) {
      this.assertPayloadMatches(key, existing, payloadHash);
      if (existing.status === "in_progress") {
        return { status: "pending", result: Promise.reject(this.inProgressError()) };
      }
      return {
        status: "cached",
        result: existing.result,
        pendingAudit: existing.pendingAudit,
        completeAudit: () => this.completeAudit(scopedKey, payloadHash),
      };
    }

    let complete: (result: BrokerExecutionResult) => void = () => {};
    let abort: (error: unknown) => void = () => {};
    const pendingResult = new Promise<BrokerExecutionResult>((resolve, reject) => {
      complete = resolve;
      abort = reject;
    });
    pendingResult.catch(() => {});
    this.pending.set(scopedKey, {
      payloadHash,
      result: pendingResult,
      complete,
      abort,
    });

    return {
      status: "reserved",
      complete: (result, pendingAudit) => {
        const current = this.pending.get(scopedKey);
        if (!current || current.payloadHash !== payloadHash) return;
        try {
          this.withLockedState((state) => {
            state.entries[scopedKey] = {
              status: "cached",
              payloadHash,
              result,
              pendingAudit,
            };
          });
        } catch (err) {
          this.pending.delete(scopedKey);
          current.abort(err);
          throw err;
        }
        if (!pendingAudit) {
          this.pending.delete(scopedKey);
          current.complete(result, pendingAudit);
        }
      },
      completeAudit: () => {
        const current = this.pending.get(scopedKey);
        let result: BrokerExecutionResult | undefined;
        try {
          this.withLockedState((state) => {
            const entry = state.entries[scopedKey];
            if (entry?.status === "cached" && entry.payloadHash === payloadHash) {
              entry.pendingAudit = undefined;
              result = entry.result;
            }
          });
        } catch (err) {
          if (current?.payloadHash === payloadHash) current.abort(err);
          throw err;
        }
        if (current?.payloadHash !== payloadHash) return;
        this.pending.delete(scopedKey);
        if (result) {
          current.complete(result);
        } else {
          current.abort(new Error("Completed idempotency result is missing."));
        }
      },
      failAudit: (error) => {
        const current = this.pending.get(scopedKey);
        if (!current || current.payloadHash !== payloadHash) return;
        this.pending.delete(scopedKey);
        current.abort(error);
      },
      abort: (error) => {
        const current = this.pending.get(scopedKey);
        if (!current || current.payloadHash !== payloadHash) return;
        this.pending.delete(scopedKey);
        try {
          this.withLockedState((state) => {
            const stored = state.entries[scopedKey];
            if (stored?.status === "in_progress" && stored.payloadHash === payloadHash) {
              delete state.entries[scopedKey];
            }
          });
        } finally {
          current.abort(error);
        }
      },
    };
  }

  private readState(): FileState {
    if (!existsSync(this.path)) return { entries: {} };
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as FileState;
    return { entries: parsed.entries ?? {} };
  }

  private withLockedState<T>(update: (state: FileState) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const lockToken = this.acquireLock(lockPath);
    try {
      const state = this.readState();
      const result = update(state);
      this.writeState(state);
      return result;
    } finally {
      this.releaseLock(lockPath, lockToken);
    }
  }

  private acquireLock(lockPath: string): string {
    const deadline = Date.now() + fileLockTimeoutMs;
    while (true) {
      const token = `${process.pid}-${randomUUID()}`;
      try {
        mkdirSync(lockPath, 0o700);
        try {
          writeFileSync(`${lockPath}/owner`, token, { mode: 0o600 });
        } catch (err) {
          rmSync(lockPath, { recursive: true, force: true });
          throw err;
        }
        return token;
      } catch (err) {
        if (!isFileExistsError(err)) throw err;
        if (this.removeStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for idempotency store lock.");
        }
        waitForFileLockRetry();
      }
    }
  }

  private releaseLock(lockPath: string, token: string): void {
    try {
      if (readFileSync(`${lockPath}/owner`, "utf8") !== token) return;
      rmSync(lockPath, { recursive: true, force: true });
    } catch (err) {
      if (!isFileMissingError(err)) throw err;
    }
  }

  private removeStaleLock(lockPath: string): boolean {
    const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      const ownerPath = `${lockPath}/owner`;
      const owner = existsSync(ownerPath) ? readFileSync(ownerPath, "utf8") : undefined;
      const ageMs = Date.now() - statSync(owner ? ownerPath : lockPath).mtimeMs;
      if (ageMs < staleFileLockMs) return false;
      renameSync(lockPath, stalePath);
      if (owner && readFileSync(`${stalePath}/owner`, "utf8") !== owner) {
        if (!existsSync(lockPath)) renameSync(stalePath, lockPath);
        return false;
      }
      rmSync(stalePath, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (isFileMissingError(err)) return true;
      if (isFileExistsError(err)) return false;
      throw err;
    }
  }

  private completeAudit(scopedKey: string, payloadHash: string): void {
    this.withLockedState((state) => {
      const entry = state.entries[scopedKey];
      if (entry?.status === "cached" && entry.payloadHash === payloadHash) {
        entry.pendingAudit = undefined;
      }
    });
  }

  private writeState(state: FileState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, "w", 0o600);
      writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tempPath, this.path);
      const dirFd = openSync(dirname(this.path), "r");
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

  private assertPayloadMatches(
    key: string,
    entry: { payloadHash: string },
    payloadHash: string,
  ): void {
    if (entry.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError(key);
    }
  }

  private inProgressError(): Error {
    return new Error("Idempotency key is already in progress.");
  }
}

export function hashIntentPayload(intent: TradingIntent): string {
  return createHash("sha256").update(stableStringify(intent)).digest("hex");
}

export function scopeIdempotencyKey(key: string, intent: TradingIntent): string {
  return stableStringify({
    key,
    principal: intent.principal,
    action: intent.action,
    resource: intent.resource,
  });
}

function waitForFileLockRetry(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}

function isFileExistsError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EEXIST";
}

function isFileMissingError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
