import type { GuardrailDecision } from "./interfaces.js";

export class IdempotencyStore {
  private store = new Map<string, { payloadHash: string; decision: GuardrailDecision }>();

  has(key: string): boolean {
    return this.store.has(key);
  }

  get(key: string, payloadHash: string): GuardrailDecision | "conflict" | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.payloadHash !== payloadHash) return "conflict";
    return entry.decision;
  }

  set(key: string, payloadHash: string, decision: GuardrailDecision): void {
    this.store.set(key, { payloadHash, decision });
  }
}

export function hashPayload(payload: unknown): string {
  return JSON.stringify(payload);
}
