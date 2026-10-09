import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuardrailDecisionToken } from "@guardrails/broker";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrokerRuntime, type Runtime } from "./runtime.js";

let directory: string;
let runtime: Runtime | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "broker-http-"));
  vi.stubEnv("GUARDRAIL_ENV", "dev");
  vi.stubEnv("GUARDRAIL_DECISION_SECRET", "dev-decision-secret");
  vi.stubEnv("AUDIT_HASH_SECRET", "dev-audit-hash-secret");
  vi.stubEnv("BROKER_AUDIT_DB_PATH", join(directory, "audit.db"));
  vi.stubEnv("BROKER_AUDIT_HASH_ANCHOR_PATH", join(directory, "head.hash"));
  vi.stubEnv("BROKER_IDEMPOTENCY_PATH", join(directory, "idempotency.json"));
  vi.stubEnv("BROKER_KILL_SWITCH", "false");
  vi.stubEnv("APPROVAL_TIMEOUT_SECONDS", "300");
});

afterEach(async () => {
  await stop();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function start() {
  runtime = createBrokerRuntime();
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("No TCP listener.");
  return `http://127.0.0.1:${address.port}/execute`;
}

async function stop() {
  if (!runtime) return;
  const current = runtime;
  runtime = undefined;
  await new Promise<void>((resolve, reject) => {
    current.server.close((error) => (error ? reject(error) : resolve()));
  });
  current.close();
}

function approval() {
  const intent = { ...binanceSpotOrder, environment: "dev" as const };
  const facts = {
    intent,
    correlationId: "signed-decision-id",
    outcome: "allow" as const,
    decidedAt: new Date().toISOString(),
  };
  return {
    ...facts,
    intentId: intent.intentId,
    decisionToken: createGuardrailDecisionToken({ ...facts, secret: "dev-decision-secret" }),
  };
}

async function execute(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-correlation-id": "execution-request" },
    body: JSON.stringify(body),
  });
}

describe("standalone broker HTTP boundary", () => {
  it("executes signed paper decisions and preserves the result across process-state reload", async () => {
    const body = approval();
    const response = await execute(await start(), body);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-correlation-id")).toBe("execution-request");
    const first = await response.json();
    expect(first).toMatchObject({
      status: "executed",
      executionKind: "cex_order",
      orderId: expect.stringMatching(/^paper-/),
      revalidationPassed: true,
    });
    await stop();
    const replay = await execute(await start(), body);
    expect(await replay.json()).toEqual(first);
  });

  it("rejects missing signatures at HTTP validation and tampering at the broker", async () => {
    const url = await start();
    const signed = approval();
    const unsigned = { ...signed, decisionToken: undefined };
    expect((await execute(url, unsigned)).status).toBe(400);
    const tampered = { ...signed, intent: { ...signed.intent, quantity: 0.001 } };
    const response = await execute(url, tampered);
    expect(await response.json()).toMatchObject({
      status: "rejected",
      revalidationPassed: false,
    });
  });

  it("honors the startup kill switch even for a correctly signed decision", async () => {
    vi.stubEnv("BROKER_KILL_SWITCH", "true");
    const response = await execute(await start(), approval());
    expect(await response.json()).toMatchObject({
      status: "rejected",
      revalidationPassed: false,
    });
  });

  it("refuses to start a simulated broker under a live environment", () => {
    vi.stubEnv("GUARDRAIL_ENV", "canary_live");
    expect(() => createBrokerRuntime()).toThrow("dev or paper");
  });
});
