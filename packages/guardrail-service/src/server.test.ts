import { once } from "node:events";
import { request, type Server } from "node:http";
import { ApprovalStore } from "@guardrails/approval";
import type { AuditEventInput } from "@guardrails/audit";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import type { GuardrailDecision } from "./interfaces.js";
import { createGuardrailServer } from "./server.js";
import { GuardrailService } from "./service.js";

const servers: Server[] = [];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

async function listen(
  options: { healthy?: boolean; outcome?: "allow" | "needs_human"; auditFailure?: boolean } = {},
) {
  const events: AuditEventInput[] = [];
  const approvals = new ApprovalStore({ defaultTimeoutSeconds: 300 });
  const service = new GuardrailService(
    {
      environment: "canary_live",
      opaUrl: "http://localhost:8181",
      approvalTimeoutSeconds: 300,
      decisionSigningSecret: "test-decision-secret-with-32-bytes",
    },
    {
      async review(intent) {
        return {
          intentId: intent.intentId,
          verdict: "approve",
          riskLevel: "low",
          reasons: ["Evidence supports this intent."],
          detectedIssues: [],
          requiredPolicyTags: [],
          reviewerModel: "test",
          reviewerProvider: "test",
          reviewedAt: new Date().toISOString(),
        };
      },
    },
    {
      async isHealthy() {
        return options.healthy ?? true;
      },
      async evaluate() {
        return {
          decision: options.outcome ?? "allow",
          reasons: [{ rule: "test-policy", message: "Policy matched this intent." }],
          requiresHumanApproval: options.outcome === "needs_human",
          matchedAllowRules: ["test-policy"],
          matchedDenyRules: [],
          evaluatedAt: new Date().toISOString(),
        };
      },
    },
    {
      async evaluate(intent) {
        return {
          intentId: intent.intentId,
          passed: true,
          checks: [{ check: "market_data_freshness", status: "pass" }],
          evaluatedAt: new Date().toISOString(),
        };
      },
    },
    {
      write(event) {
        if (options.auditFailure) throw new Error("VAULT_TOKEN=s.super-secret");
        events.push(event);
      },
    },
    approvals,
  );
  const server = createGuardrailServer(service);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP listener.");
  return { origin: `http://127.0.0.1:${address.port}`, events, approvals };
}

async function evaluate(origin: string, correlationId?: string) {
  return fetch(`${origin}/evaluate`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(correlationId === undefined ? {} : { "x-correlation-id": correlationId }),
    },
    body: JSON.stringify(binanceSpotOrder),
  });
}

describe("guardrail HTTP boundary", () => {
  it("returns a non-executable preview without opening a human approval", async () => {
    const { origin, approvals } = await listen({ outcome: "needs_human" });
    const response = await fetch(`${origin}/dry-run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-correlation-id": "preview-http" },
      body: JSON.stringify(binanceSpotOrder),
    });
    expect(response.status).toBe(200);
    const preview = (await response.json()) as GuardrailDecision;
    expect(preview).toMatchObject({
      dryRun: true,
      outcome: "needs_human",
      correlationId: "preview-http",
      requiresHumanApproval: true,
    });
    expect(preview.approvalId).toBeUndefined();
    expect(approvals.list()).toEqual([]);
  });

  it.each([true, false])("reports actual policy health (healthy=%s)", async (healthy) => {
    const { origin } = await listen({ healthy });
    const response = await fetch(`${origin}/health`, {
      headers: { "x-correlation-id": "health-1" },
    });
    expect(response.status).toBe(healthy ? 200 : 503);
    expect(response.headers.get("x-correlation-id")).toBe("health-1");
    expect(await response.json()).toEqual({
      status: healthy ? "ok" : "degraded",
      opaHealthy: healthy,
    });
  });

  it("carries supplied and generated IDs into audit and re-signs cached allow decisions", async () => {
    const { origin, events } = await listen();
    const first = await evaluate(origin, "agent-eval-42");
    const decision = (await first.json()) as GuardrailDecision;
    expect(first.status).toBe(200);
    expect(first.headers.get("x-correlation-id")).toBe("agent-eval-42");
    expect(decision).toMatchObject({
      intentId: binanceSpotOrder.intentId,
      outcome: "allow",
      correlationId: "agent-eval-42",
    });
    expect(decision.decisionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(events.find((event) => event.eventType === "intent.received")?.correlationId).toBe(
      "agent-eval-42",
    );
    expect(events.at(-1)).toMatchObject({
      eventType: "decision.final",
      correlationId: "agent-eval-42",
    });
    const second = await evaluate(origin);
    const replay = (await second.json()) as GuardrailDecision;
    expect(second.headers.get("x-correlation-id")).toMatch(uuid);
    expect(replay.correlationId).toBe(second.headers.get("x-correlation-id"));
    expect(replay.decidedAt).toBe(decision.decidedAt);
    expect(replay.decisionToken).not.toBe(decision.decisionToken);
    expect(events.at(-1)?.correlationId).toBe(replay.correlationId);
  });

  it.each([
    ["{", "application/json", 400],
    ["", "application/json", 400],
    [JSON.stringify({ action: "cex.withdraw" }), "application/json", 400],
    [JSON.stringify(binanceSpotOrder), "text/plain", 415],
  ])("rejects invalid input before evaluation (%s)", async (body, contentType, status) => {
    const { origin, events } = await listen();
    const response = await fetch(`${origin}/evaluate`, {
      method: "POST",
      headers: { "content-type": String(contentType), "x-correlation-id": "invalid-input" },
      body: String(body),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("x-correlation-id")).toBe("invalid-input");
    expect(await response.json()).toMatchObject({ correlationId: "invalid-input" });
    expect(events).toEqual([]);
  });

  it.each([
    "",
    "not a valid id",
    "a".repeat(129),
    "first, second",
  ])("rejects unsafe correlation IDs (%s)", async (id) => {
    const { origin, events } = await listen();
    const response = await evaluate(origin, id);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-correlation-id")).toMatch(uuid);
    expect(response.headers.get("x-correlation-id")).not.toBe(id);
    expect(await response.json()).toMatchObject({
      correlationId: response.headers.get("x-correlation-id"),
    });
    expect(events).toEqual([]);
  });

  it("accepts the maximum safe correlation ID length", async () => {
    const { origin } = await listen();
    const response = await evaluate(origin, "a".repeat(128));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      correlationId: "a".repeat(128),
      outcome: "allow",
    });
  });

  it.each([
    ["/unknown", "POST", 404, null],
    ["/evaluate", "GET", 405, "POST"],
    ["/dry-run", "GET", 405, "POST"],
    ["/health", "POST", 405, "GET"],
  ])("rejects unsupported route or method (%s %s)", async (path, method, status, allow) => {
    const { origin, events } = await listen();
    const response = await fetch(`${origin}${path}`, { method: String(method) });
    expect(response.status).toBe(status);
    expect(response.headers.get("allow")).toBe(allow);
    expect(response.headers.get("x-correlation-id")).toMatch(uuid);
    expect(events).toEqual([]);
  });

  it.each([
    false,
    true,
  ])("returns 413 without waiting for an oversized upload to finish (chunked=%s)", async (chunked) => {
    const { origin, events } = await listen();
    const response = await new Promise<{
      status: number | undefined;
      correlation: string | string[] | undefined;
      body: string;
    }>((resolve, reject) => {
      const client = request(
        `${origin}/evaluate`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-correlation-id": "body-limit",
            ...(chunked ? { "transfer-encoding": "chunked" } : { "content-length": 1_048_577 }),
          },
        },
        (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk) => {
            body += chunk;
          });
          incoming.on("error", reject);
          incoming.on("end", () => {
            client.end();
            resolve({
              status: incoming.statusCode,
              correlation: incoming.headers["x-correlation-id"],
              body,
            });
          });
        },
      );
      client.on("error", reject);
      client.write(Buffer.alloc(1_048_577, 0x61));
    });
    expect(response.status).toBe(413);
    expect(response.correlation).toBe("body-limit");
    expect(JSON.parse(response.body)).toMatchObject({ correlationId: "body-limit" });
    expect(events).toEqual([]);
  });

  it("preserves approval binding on replay while labeling the new HTTP request", async () => {
    const { origin, events, approvals } = await listen({ outcome: "needs_human" });
    const first = await evaluate(origin, "approval-binding");
    const decision = (await first.json()) as GuardrailDecision;
    expect(decision.outcome).toBe("needs_human");
    const second = await evaluate(origin, "new-request");
    const replay = (await second.json()) as GuardrailDecision;
    expect(second.headers.get("x-correlation-id")).toBe("new-request");
    expect(replay).toMatchObject({
      correlationId: "approval-binding",
      approvalId: decision.approvalId,
      decisionToken: decision.decisionToken,
    });
    expect(approvals.get(decision.approvalId ?? "")).toMatchObject({
      correlationId: "approval-binding",
    });
    expect(events.filter((event) => event.eventType === "approval.requested")).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "intent.received").at(-1)?.correlationId,
    ).toBe("new-request");
  });

  it("fails closed without exposing internal audit errors", async () => {
    const { origin } = await listen({ auditFailure: true });
    const response = await evaluate(origin, "audit-failure");
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ correlationId: "audit-failure" });
    expect(JSON.stringify(body)).not.toContain("VAULT_TOKEN");
    expect(JSON.stringify(body)).not.toContain("super-secret");
    expect(body).not.toHaveProperty("decisionToken");
  });
});
