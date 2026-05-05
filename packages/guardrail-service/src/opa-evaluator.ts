import type { PolicyInput, PolicyOutput } from "@guardrails/schemas";
import type { PolicyEvaluator } from "./interfaces.js";
import { transformOpaOutput } from "./opa-transform.js";

export interface OpaHttpPolicyEvaluatorConfig {
  opaUrl?: string;
  timeoutMs?: number;
}

interface OpaDataResponse {
  result?: unknown;
}

export class OpaHttpPolicyEvaluator implements PolicyEvaluator {
  private opaUrl: URL;
  private timeoutMs: number;

  constructor(config: OpaHttpPolicyEvaluatorConfig = {}) {
    this.opaUrl = new URL(config.opaUrl ?? "http://localhost:8181");
    this.timeoutMs = config.timeoutMs ?? 5000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new Error("OPA HTTP timeout must be a positive finite 32-bit delay.");
    }
  }

  async evaluate(input: PolicyInput): Promise<PolicyOutput> {
    return this.withTimeout(async (signal) => {
      const response = await fetch(this.urlFor("/v1/data/guardrail"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`OPA policy evaluation failed with HTTP ${response.status}.`);
      }

      const body = (await response.json()) as OpaDataResponse;
      if (!body.result || typeof body.result !== "object") {
        throw new Error("OPA policy evaluation response did not include an object result.");
      }
      return transformOpaOutput(body.result as Record<string, unknown>);
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.withTimeout((signal) =>
        fetch(this.urlFor("/health"), { method: "GET", signal }),
      );
      return response.status === 200;
    } catch {
      return false;
    }
  }

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private urlFor(pathname: string): URL {
    const url = new URL(this.opaUrl);
    const basePath = this.opaUrl.pathname.replace(/\/$/, "");
    url.pathname = `${basePath}${pathname}`;
    url.search = "";
    return url;
  }
}
