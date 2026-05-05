import type { GuardrailDecision } from "./interfaces.js";

type IdempotencyEntry =
  | { status: "complete"; payloadHash: string; decision: GuardrailDecision }
  | {
      status: "pending";
      payloadHash: string;
      promise: Promise<GuardrailDecision>;
      resolve(decision: GuardrailDecision): void;
      reject(error: unknown): void;
    };

export class IdempotencyStore {
  private store = new Map<string, IdempotencyEntry>();

  has(key: string): boolean {
    return this.store.has(key);
  }

  get(
    key: string,
    payloadHash: string,
  ): GuardrailDecision | "conflict" | Promise<GuardrailDecision> | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.payloadHash !== payloadHash) return "conflict";
    return entry.status === "complete" ? entry.decision : entry.promise;
  }

  reserve(key: string, payloadHash: string): void {
    if (this.store.has(key)) return;
    let resolve: (decision: GuardrailDecision) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<GuardrailDecision>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    promise.catch(() => {});
    this.store.set(key, { status: "pending", payloadHash, promise, resolve, reject });
  }

  set(key: string, payloadHash: string, decision: GuardrailDecision): void {
    const entry = this.store.get(key);
    this.store.set(key, { status: "complete", payloadHash, decision });
    if (entry?.status === "pending" && entry.payloadHash === payloadHash) {
      entry.resolve(decision);
    }
  }

  abort(key: string, payloadHash: string, error: unknown): void {
    const entry = this.store.get(key);
    if (entry?.status !== "pending" || entry.payloadHash !== payloadHash) return;
    this.store.delete(key);
    entry.reject(error);
  }
}

export function hashPayload(payload: unknown): string {
  return stableJson(payload);
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
