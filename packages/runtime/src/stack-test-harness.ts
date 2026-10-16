// Test infrastructure only. Production entrypoints never import this module.
// Deadlines below only bound real subprocess/socket hangs; readiness and shutdown await events.
// A fake parent clock cannot drive the independent runtime processes or TCP stack.
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalStore } from "@guardrails/approval";
import { PolicyInput, TradingIntent } from "@guardrails/schemas";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import type { GuardrailDecision } from "@guardrails/service";
import Database from "better-sqlite3";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export const stackSecrets = {
  OPENAI_API_KEY: "acceptance-openai-key-not-real",
  GUARDRAIL_DECISION_SECRET: "acceptance-decision-signing-secret-not-real",
  AUDIT_HASH_SECRET: "acceptance-audit-signing-secret-not-real",
  VAULT_TOKEN: "acceptance-vault-token-not-real",
  API_SECRET: "acceptance-exchange-secret-not-real",
  PRIVATE_KEY: "acceptance-private-key-not-real",
};

export function stackIntent(overrides: Partial<typeof binanceSpotOrder> = {}) {
  return {
    ...binanceSpotOrder,
    environment: "dev" as const,
    intentId: randomUUID(),
    idempotencyKey: randomUUID(),
    requestedAt: new Date().toISOString(),
    quantity: 0.002,
    price: 3500,
    maxNotionalUsd: 7,
    ...overrides,
  };
}

export async function startAcceptanceStack() {
  const directory = await mkdtemp(join(tmpdir(), "guardrail-http-acceptance-"));
  const servers: Server[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const logs: string[] = [];
  const fixtureErrors: unknown[] = [];
  const mode: {
    reviewer: "approve" | "malformed" | "unavailable";
    policy: "allow" | "deny" | "needs_human" | "malformed" | "unavailable";
    opaHealthy: boolean;
  } = { reviewer: "approve", policy: "allow", opaHealthy: true };
  const approvalsPath = join(directory, "approvals.db");
  const riskPath = join(directory, "risk.json");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...stackSecrets,
    GUARDRAIL_ENV: "dev",
    GUARDRAIL_HOST: "127.0.0.1",
    GUARDRAIL_PORT: "0",
    BROKER_HOST: "127.0.0.1",
    BROKER_PORT: "0",
    BROKER_CONNECTOR: "paper",
    BROKER_KILL_SWITCH: "false",
    REVIEWER_PROVIDER: "openai",
    REVIEWER_MODEL: "gpt-5.5",
    RISK_DATA_PROVIDER: "file",
    RISK_DATA_PATH: riskPath,
    APPROVAL_DB_PATH: approvalsPath,
    APPROVAL_TIMEOUT_SECONDS: "300",
    GUARDRAIL_AUDIT_DB_PATH: join(directory, "guardrail-audit.db"),
    GUARDRAIL_AUDIT_HASH_ANCHOR_PATH: join(directory, "guardrail.hash"),
    BROKER_AUDIT_DB_PATH: join(directory, "broker-audit.db"),
    BROKER_AUDIT_HASH_ANCHOR_PATH: join(directory, "broker.hash"),
    BROKER_IDEMPOTENCY_PATH: join(directory, "idempotency.json"),
  };

  async function freshRisk(ageMs = 0) {
    const timestampMs = Date.now() - ageMs;
    await writeFile(
      `${riskPath}.tmp`,
      JSON.stringify({
        marketData: [{ symbol: "ETH-USDC", price: 3500, timestampMs }],
        portfolios: [{ account: "subaccount-1", positions: [], timestampMs }],
        dailyStats: [
          {
            account: "subaccount-1",
            date: new Date().toISOString().slice(0, 10),
            totalNotionalUsd: 0,
            realizedLossUsd: 0,
            orderCount: 0,
          },
        ],
        lastOrderTimestamps: { "subaccount-1": null },
      }),
    );
    await rename(`${riskPath}.tmp`, riskPath);
  }

  async function close() {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    await rm(directory, { recursive: true, force: true });
    if (fixtureErrors.length)
      throw new AggregateError(fixtureErrors, "Unexpected infrastructure request");
  }

  async function infrastructure(kind: "openai" | "opa") {
    const server = createServer((request, response) => {
      void (async () => {
        response.setHeader("content-type", "application/json");
        if (kind === "opa" && request.url === "/health" && request.method === "GET") {
          response.statusCode = mode.opaHealthy ? 200 : 503;
          response.end("{}");
          return;
        }
        assert.equal(request.method, "POST");
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (kind === "openai") {
          assert.equal(request.url, "/v1/chat/completions");
          assert.equal(request.headers.authorization, `Bearer ${stackSecrets.OPENAI_API_KEY}`);
          const prompt = body.messages[0].content as string;
          const intent = TradingIntent.parse(
            JSON.parse(prompt.split("## Intent\n")[1].split("\n## Detection Labels")[0]),
          );
          if (mode.reviewer === "unavailable") {
            response.statusCode = 503;
            response.end(JSON.stringify({ error: { message: "Fixture reviewer offline" } }));
            return;
          }
          const verdict = {
            intentId: intent.intentId,
            verdict: "approve",
            riskLevel: "low",
            reasons: ["Fixture advisory review"],
            detectedIssues: [],
            requiredPolicyTags: [],
            reviewerModel: "gpt-5.5",
            reviewerProvider: "openai",
            reviewedAt: new Date().toISOString(),
          };
          response.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: mode.reviewer === "malformed" ? "not-json" : JSON.stringify(verdict),
                  },
                },
              ],
            }),
          );
          return;
        }
        assert.equal(request.url, "/v1/data/guardrail");
        PolicyInput.parse(body.input);
        if (mode.policy === "unavailable") {
          response.statusCode = 503;
          response.end("{}");
          return;
        }
        const decision = mode.policy;
        const rule =
          decision === "deny"
            ? "fixture_hard_deny"
            : decision === "needs_human"
              ? "fixture_human_required"
              : "fixture_allow";
        response.end(
          JSON.stringify({
            result:
              decision === "malformed"
                ? { decision: "allow" }
                : {
                    decision,
                    reasons: [{ rule, message: "HTTP policy fixture" }],
                    requires_human_approval: decision === "needs_human",
                    matched_allow_rules: decision === "deny" ? [] : ["fixture_allow"],
                    matched_deny_rules: decision === "deny" ? [rule] : [],
                  },
          }),
        );
      })().catch((error: unknown) => {
        fixtureErrors.push(error);
        response.statusCode = 500;
        response.end("{}");
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  }

  function launch(role: "service" | "broker") {
    const child = spawn(process.execPath, [`packages/runtime/dist/${role}-main.js`], {
      cwd: root,
      env,
      stdio: "pipe",
    });
    children.push(child);
    child.stderr.on("data", (data: Buffer) => logs.push(data.toString()));
    return new Promise<string>((resolve, reject) => {
      let buffered = "";
      const timer = setTimeout(
        () => reject(new Error(`${role} startup timed out: ${logs.join("")}`)),
        15_000,
      );
      const fail = () => {
        clearTimeout(timer);
        reject(new Error(`${role} exited before listening: ${logs.join("")}`));
      };
      child.once("error", fail);
      child.once("exit", fail);
      child.stdout.on("data", (data: Buffer) => {
        logs.push(data.toString());
        buffered += data;
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          try {
            const event = JSON.parse(line);
            if (event.event === "listening") {
              clearTimeout(timer);
              child.removeListener("exit", fail);
              child.removeListener("error", fail);
              resolve(`http://127.0.0.1:${event.address.port}`);
            }
          } catch {
            /* Non-readiness output is retained for diagnostics. */
          }
        }
      });
    });
  }

  try {
    env.REVIEWER_BASE_URL = `${await infrastructure("openai")}/v1`;
    env.OPA_URL = await infrastructure("opa");
    await freshRisk();
    const url = await launch("service");
    const brokerUrl = await launch("broker");
    for (const base of [url, brokerUrl]) {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      await response.json();
    }
    return {
      url,
      brokerUrl,
      mode,
      freshRisk,
      close,
      logs: () => logs.join(""),
      audit(role: "guardrail" | "broker" = "guardrail") {
        const db = new Database(join(directory, `${role}-audit.db`), { readonly: true });
        try {
          return db
            .prepare(
              "SELECT event_type, intent_id, correlation_id, data FROM audit_events ORDER BY id",
            )
            .all() as {
            event_type: string;
            intent_id: string | null;
            correlation_id: string;
            data: string;
          }[];
        } finally {
          db.close();
        }
      },
      approvals() {
        const store = new ApprovalStore({
          databasePath: approvalsPath,
          defaultTimeoutSeconds: 300,
        });
        try {
          return store.list();
        } finally {
          store.close();
        }
      },
      approve(approvalId: string) {
        const store = new ApprovalStore({
          databasePath: approvalsPath,
          defaultTimeoutSeconds: 300,
        });
        try {
          return store.approve(approvalId, "acceptance-operator");
        } finally {
          store.close();
        }
      },
      async evaluate(intent: TradingIntent, correlationId = randomUUID()) {
        const response = await fetch(`${url}/evaluate`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-correlation-id": correlationId },
          body: JSON.stringify(intent),
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-correlation-id"), correlationId);
        return (await response.json()) as GuardrailDecision;
      },
      async execute(approval: unknown) {
        return fetch(`${brokerUrl}/execute`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(approval),
          signal: AbortSignal.timeout(5000),
        });
      },
      async agent(intent: TradingIntent) {
        const child = spawn(process.execPath, ["packages/agent-adapters/dist/main.js"], {
          cwd: root,
          env: { PATH: process.env.PATH, GUARDRAIL_URL: url },
          stdio: "pipe",
        });
        children.push(child);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data: Buffer) => {
          stdout += data;
        });
        child.stderr.on("data", (data: Buffer) => {
          stderr += data;
        });
        const exited = once(child, "exit");
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.stdin.end(`${JSON.stringify(intent)}\n`);
        try {
          const [code] = await exited;
          assert.equal(code, 0, stderr);
          return JSON.parse(stdout) as GuardrailDecision;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
