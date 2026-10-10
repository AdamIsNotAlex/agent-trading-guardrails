import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runHermesBridge } from "./hermes-bridge.js";
import plugin, { type OpenClawTool } from "./openclaw-plugin.js";

const servers: Server[] = [];
const params = {
  ...binanceSpotOrder,
  principal: "spoofed-model-principal",
  environment: "production",
};

async function listen(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
  ) => void,
) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    handler(request, response, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP listener.");
  return `http://127.0.0.1:${address.port}`;
}

function decision(intentId: unknown, overrides: Record<string, unknown> = {}) {
  return {
    intentId,
    correlationId: "original-decision",
    outcome: "allow",
    reasons: [],
    requiresHumanApproval: false,
    decidedAt: new Date().toISOString(),
    reviewerVerdict: null,
    riskResult: null,
    policyOutput: null,
    decisionToken: "a".repeat(64),
    ...overrides,
  };
}

function tools(url: string, timeoutMs = 30_000): Map<string, OpenClawTool> {
  const registered = new Map<string, OpenClawTool>();
  plugin.register({
    pluginConfig: {
      guardrailUrl: url,
      principal: "agent.openclaw.bound",
      environment: "paper",
      timeoutMs,
    },
    registerTool(tool) {
      registered.set(tool.name, tool);
    },
  });
  return registered;
}

function propose(registered: Map<string, OpenClawTool>) {
  const tool = registered.get("guardrails_propose_order");
  if (!tool) throw new Error("Order tool not registered.");
  return tool;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

describe("OpenClaw native tool boundary", () => {
  it("binds operator identity and preserves pending approval instead of treating authorization as execution", async () => {
    const received: Record<string, unknown>[] = [];
    const url = await listen((request, response, body) => {
      expect(request.url).toBe("/evaluate");
      received.push(body);
      response.writeHead(200, {
        "content-type": "application/json",
        "x-correlation-id": "current-request",
      });
      response.end(
        JSON.stringify(
          decision(body.intentId, {
            outcome: "needs_human",
            requiresHumanApproval: true,
            approvalId: "550e8400-e29b-41d4-a716-446655440055",
          }),
        ),
      );
    });
    const result = await propose(tools(url)).execute("framework-call-id", params);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      principal: "agent.openclaw.bound",
      environment: "paper",
      action: "cex.place_order",
    });
    expect(result.details).toMatchObject({
      success: false,
      outcome: "needs_human",
      correlationId: "original-decision",
      approvalId: "550e8400-e29b-41d4-a716-446655440055",
    });
    expect(result.details).not.toHaveProperty("orderId");
  });

  it("does not follow a redirect into an execution endpoint", async () => {
    const paths: string[] = [];
    const url = await listen((request, response, body) => {
      paths.push(request.url ?? "");
      if (request.url === "/evaluate") {
        response.writeHead(307, { location: "/execute" });
        response.end();
      } else {
        response.end(JSON.stringify(decision(body.intentId)));
      }
    });
    const result = await propose(tools(url)).execute("call", params);
    expect(paths).toEqual(["/evaluate"]);
    expect(result.details.success).toBe(false);
    expect(result.details.outcome).toBe("deny");
    expect(result.details.decisionToken).toBeUndefined();
  });

  it("fails closed for unsigned allows, malformed pending approvals, and service errors", async () => {
    for (const bad of [
      { status: 200, fields: { decisionToken: undefined } },
      { status: 200, fields: { outcome: "needs_human", requiresHumanApproval: true } },
      { status: 503, fields: { secret: "must-not-escape" } },
    ]) {
      const url = await listen((_request, response, body) => {
        response.writeHead(bad.status, { "content-type": "application/json" });
        response.end(JSON.stringify(decision(body.intentId, bad.fields)));
      });
      const result = await propose(tools(url)).execute("call", params);
      expect(result.details.success).toBe(false);
      expect(result.details.outcome).toBe("deny");
      expect(JSON.stringify(result)).not.toContain("must-not-escape");
      expect(result.details.decisionToken).toBeUndefined();
    }
  });

  it("honors cancellation without making a request and bounds stalled remote calls", async () => {
    let requests = 0;
    const url = await listen(() => {
      requests++;
    });
    const tool = propose(tools(url, 50));
    const controller = new AbortController();
    controller.abort();
    const canceled = await tool.execute("canceled", params, controller.signal);
    expect(canceled.details.reasons[0].rule).toBe("interrupted");
    expect(requests).toBe(0);
    const stalled = await tool.execute("stalled", params);
    expect(stalled.details.reasons[0].rule).toBe("timeout");
    expect(stalled.details.success).toBe(false);
  });

  it("refuses missing trusted identity before registering callable tools", () => {
    let registered = 0;
    expect(() =>
      plugin.register({
        pluginConfig: { guardrailUrl: "http://127.0.0.1:3000", environment: "paper" },
        registerTool() {
          registered++;
        },
      }),
    ).toThrow();
    expect(registered).toBe(0);
  });
});

describe("Hermes native bridge boundary", () => {
  async function invoke(url: string, invocation: unknown) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let text = "";
    stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    stdin.end(JSON.stringify(invocation));
    const code = await runHermesBridge({
      stdin,
      stdout,
      env: {
        GUARDRAIL_URL: url,
        GUARDRAIL_PRINCIPAL: "agent.hermes.bound",
        GUARDRAIL_ENV: "paper",
      },
    });
    return { code, result: JSON.parse(text) };
  }

  it("routes the Python invocation format through the same remote decision and trusted context", async () => {
    const received: Record<string, unknown>[] = [];
    const url = await listen((request, response, body) => {
      expect(request.url).toBe("/evaluate");
      received.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          decision(body.intentId, {
            outcome: "deny",
            reasons: [{ rule: "risk_limit", message: "Over budget." }],
          }),
        ),
      );
    });
    const { code, result } = await invoke(url, { toolName: "propose_order", params });
    expect(code).toBe(0);
    expect(received[0]).toMatchObject({ principal: "agent.hermes.bound", environment: "paper" });
    expect(result).toMatchObject({
      success: false,
      outcome: "deny",
      reasons: [{ rule: "risk_limit", message: "Over budget." }],
    });
    expect(result.decisionToken).toBeUndefined();
  });

  it("refuses arbitrary tools and malformed requests without contacting the service", async () => {
    let requests = 0;
    const url = await listen(() => {
      requests++;
    });
    expect((await invoke(url, { toolName: "execute", params })).result.outcome).toBe("deny");
    expect((await invoke(url, { toolName: "propose_order", params: null })).code).toBe(1);
    expect((await invoke(url, { toolName: "propose_order", params: {} })).result.outcome).toBe(
      "deny",
    );
    expect(requests).toBe(0);
  });
});
