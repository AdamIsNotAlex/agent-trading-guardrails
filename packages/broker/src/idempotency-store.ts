import { createHash } from "node:crypto";
import type { BrokerExecutionResult, TradingIntent } from "@guardrails/schemas";
import {
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
  expiresAt?: number;
}

interface PendingEntry {
  status: "pending";
  payloadHash: string;
  result: Promise<BrokerExecutionResult>;
  complete(result: BrokerExecutionResult): void;
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
        return { status: "cached", result: entry.result };
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
      complete: (result) => {
        this.entries.set(scopedKey, {
          status: "cached",
          payloadHash,
          result,
          expiresAt: this.options.ttlMs === undefined ? undefined : this.now() + this.options.ttlMs,
        });
        complete(result);
      },
      abort: (error) => {
        this.entries.delete(scopedKey);
        abort(error);
      },
    });

    return {
      status: "reserved",
      complete: (result) => {
        const current = this.entries.get(scopedKey);
        if (current?.status === "pending" && current.payloadHash === payloadHash) {
          current.complete(result);
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

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.status === "cached" && entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private assertPayloadMatches(key: string, entry: IdempotencyEntry, payloadHash: string): void {
    if (entry.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError(key);
    }
  }
}

export function hashIntentPayload(intent: TradingIntent): string {
  return createHash("sha256").update(stableStringify(intent)).digest("hex");
}

function scopeIdempotencyKey(key: string, intent: TradingIntent): string {
  return stableStringify({
    key,
    principal: intent.principal,
    action: intent.action,
    resource: intent.resource,
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
