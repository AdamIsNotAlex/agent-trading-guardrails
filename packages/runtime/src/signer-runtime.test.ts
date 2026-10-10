import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditWriter } from "@guardrails/audit";
import { createGuardrailDecisionToken } from "@guardrails/broker";
import type { OnchainSigningIntent } from "@guardrails/schemas";
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializedEIP1559,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "./runtime.js";
import { OfflineSignature, type SigningRequest } from "./signer-request.js";
import { createSignerRuntime } from "./signer-runtime.js";

let directory: string;
let runtime: Runtime | undefined;
const secret = "dev-decision-secret";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "offline-signer-"));
  for (const [key, value] of Object.entries({
    GUARDRAIL_ENV: "dev",
    GUARDRAIL_DECISION_SECRET: secret,
    AUDIT_HASH_SECRET: "dev-audit-hash-secret",
    VAULT_ADDR: "",
    SIGNER_KEY_PATH: join(directory, "key"),
    SIGNER_AUDIT_DB_PATH: join(directory, "audit.db"),
    SIGNER_AUDIT_HASH_ANCHOR_PATH: join(directory, "head.hash"),
    SIGNER_MAX_GAS: "1000000",
    SIGNER_MAX_FEE_PER_GAS: "100000000000",
    SIGNER_MAX_TOTAL_FEE_WEI: "10000000000000000",
  }))
    vi.stubEnv(key, value);
});

afterEach(async () => {
  await stop();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function start() {
  runtime = createSignerRuntime();
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("No TCP listener.");
  return `http://127.0.0.1:${address.port}`;
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

function request() {
  const to = "0x1111111111111111111111111111111111111111";
  const intent: OnchainSigningIntent = {
    intentId: randomUUID(),
    principal: "agent.local.signer-test",
    action: "onchain.request_signature",
    resource: `onchain:ethereum:sepolia:${to}`,
    environment: "dev",
    requestedAt: new Date().toISOString(),
    idempotencyKey: randomUUID(),
    rationale: "Offline signing boundary verification.",
    evidence: ["local-simulation-reference"],
    chain: "ethereum",
    chainEnvironment: "sepolia",
    to,
    data: "0x",
    value: "0",
    simulationId: randomUUID(),
    expectedDeltas: [{ address: to, asset: "ETH", minDelta: "0", maxDelta: "0" }],
  };
  const approval = {
    intent,
    intentId: intent.intentId,
    correlationId: "signed-approval-id",
    outcome: "allow" as const,
    decidedAt: new Date().toISOString(),
    decisionToken: "",
  };
  approval.decisionToken = createGuardrailDecisionToken({ ...approval, secret });
  return {
    approval,
    transaction: {
      nonce: 0,
      gas: "21000",
      maxFeePerGas: "2000000000",
      maxPriorityFeePerGas: "1000000000",
    },
  };
}

function seal(body: SigningRequest) {
  body.approval.decisionToken = createGuardrailDecisionToken({ ...body.approval, secret });
  return body;
}

function sign(url: string, body: unknown) {
  return fetch(`${url}/sign`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-correlation-id": "transport-request" },
    body: JSON.stringify(body),
  });
}

describe("isolated offline Sepolia signer", () => {
  it("returns a real recoverable signature bound to the approved transaction, with no broadcast claim", async () => {
    const url = await start();
    const body = request();
    const response = await sign(url, body);
    expect(response.status).toBe(200);
    const result = OfflineSignature.parse(await response.json());
    expect(result).toMatchObject({
      mode: "offline-sepolia",
      chainId: 11155111,
      intentId: body.approval.intentId,
    });
    expect(result).not.toHaveProperty("status", "executed");
    const serializedTransaction = result.signedTransaction as TransactionSerializedEIP1559;
    expect(await recoverTransactionAddress({ serializedTransaction })).toBe(result.address);
    expect(keccak256(serializedTransaction)).toBe(result.transactionHash);
    expect(parseTransaction(serializedTransaction)).toMatchObject({
      chainId: 11155111,
      to: body.approval.intent.to,
      nonce: 0,
      gas: 21000n,
      maxFeePerGas: 2000000000n,
      maxPriorityFeePerGas: 1000000000n,
    });
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ address: result.address });
    expect(statSync(join(directory, "key")).mode & 0o777).toBe(0o600);
  });

  it("rejects token tampering without consuming the valid signing authorization", async () => {
    const url = await start();
    const body = request();
    const changed = structuredClone(body);
    changed.approval.intent.value = "1";
    expect((await sign(url, changed)).status).toBe(403);
    expect((await sign(url, body)).status).toBe(200);
  });

  it.each([
    "expired",
    "future",
    "environment",
    "chain",
    "intent-id",
  ])("rejects correctly authenticated but invalid %s context", async (scenario) => {
    const url = await start();
    const body = request();
    if (scenario === "expired")
      body.approval.decidedAt = new Date(Date.now() - 301000).toISOString();
    if (scenario === "future") body.approval.decidedAt = new Date(Date.now() + 60000).toISOString();
    if (scenario === "environment") body.approval.intent.environment = "paper";
    if (scenario === "chain") body.approval.intent.chainEnvironment = "mainnet";
    if (scenario === "intent-id") body.approval.intentId = randomUUID();
    expect((await sign(url, seal(body))).status).toBe(403);
  });

  it("refuses unresolved human approval and arbitrary transaction field overrides", async () => {
    const url = await start();
    const body = request();
    expect(
      (
        await sign(url, {
          ...body,
          approval: { ...body.approval, outcome: "needs_human", approvalId: randomUUID() },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await sign(url, {
          ...body,
          transaction: { ...body.transaction, to: body.approval.intent.to, chainId: 1 },
        })
      ).status,
    ).toBe(400);
  });

  it("preserves the key and one-use nonce/envelope binding across restarts", async () => {
    const body = request();
    const first = await (await sign(await start(), body)).json();
    await stop();
    const url = await start();
    expect(await (await sign(url, body)).json()).toEqual(first);
    expect(
      (await sign(url, { ...body, transaction: { ...body.transaction, nonce: 1 } })).status,
    ).toBe(409);
    const repeatedIntent = structuredClone(body);
    repeatedIntent.approval.intent.idempotencyKey = randomUUID();
    repeatedIntent.transaction.nonce = 1;
    expect((await sign(url, seal(repeatedIntent))).status).toBe(409);
    expect((await sign(url, request())).status).toBe(409); // another intent cannot reuse nonce 0
  });

  it.each([
    "abc",
    "-1",
    "01",
    (1n << 256n).toString(),
  ])("rejects noncanonical/out-of-range transaction integer %s", async (gas) => {
    const body = request();
    body.transaction.gas = gas;
    expect((await sign(await start(), body)).status).toBe(400);
  });

  it.each([
    { gas: "1000001" },
    { maxFeePerGas: "100000000001" },
    { maxPriorityFeePerGas: "3000000000" },
    { gas: "1000000", maxFeePerGas: "100000000000" },
  ])("rejects gas, priority, and aggregate fee cap violations %j", async (fields) => {
    const body = request();
    Object.assign(body.transaction, fields);
    expect((await sign(await start(), body)).status).toBe(403);
  });

  it("accepts exactly the configured aggregate fee ceiling", async () => {
    const body = request();
    body.transaction.gas = "100000";
    body.transaction.maxFeePerGas = "100000000000";
    expect((await sign(await start(), body)).status).toBe(200);
  });

  it.each([
    "malformed",
    "unlimited",
    "excess",
  ])("refuses %s ERC20 approvals despite a valid decision token", async (scenario) => {
    const body = request();
    const amount = scenario === "unlimited" ? "f".repeat(64) : "65".padStart(64, "0");
    body.approval.intent.data =
      scenario === "malformed" ? "0x095ea7b3" : `0x095ea7b3${"1".repeat(64)}${amount}`;
    body.approval.intent.maxTokenApprovalAmount = "100";
    expect((await sign(await start(), seal(body))).status).toBe(403);
  });

  it("does not publish or re-sign an authorization after an audit failure", async () => {
    const url = await start();
    const body = request();
    vi.spyOn(AuditWriter.prototype, "write").mockImplementationOnce(() => {
      throw new Error("audit unavailable");
    });
    const failed = await sign(url, body);
    expect(failed.status).toBe(500);
    expect(await failed.json()).not.toHaveProperty("signedTransaction");
    expect((await sign(url, body)).status).toBe(409);
    expect(
      (await sign(url, { ...body, transaction: { ...body.transaction, nonce: 1 } })).status,
    ).toBe(409);
  });

  it("never replaces a malformed existing private key", () => {
    const path = join(directory, "key");
    writeFileSync(path, "invalid-key", { mode: 0o600 });
    expect(() => createSignerRuntime()).toThrow(Error);
    expect(readFileSync(path, "utf8")).toBe("invalid-key");
  });

  it("refuses live profiles before generating keys", () => {
    vi.stubEnv("GUARDRAIL_ENV", "production");
    expect(() => createSignerRuntime()).toThrow(Error);
    expect(existsSync(join(directory, "key"))).toBe(false);
  });
});
