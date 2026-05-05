import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PolicyInput } from "@guardrails/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpaHttpPolicyEvaluator } from "./opa-evaluator.js";

let server: ReturnType<typeof createServer>;
let opaUrl: string;
let healthStatus: number;
let evaluationStatus: number;
let evaluationBody: unknown;
let stallEvaluation: boolean;
let stallEvaluationBody: boolean;
const requests: Array<{ method: string; url: string; body: unknown }> = [];

const policyInput: PolicyInput = {
  intentId: "550e8400-e29b-41d4-a716-446655440000",
  principal: "agent:test",
  action: "cex.place_order",
  resource: "cex:binance:spot:ETH-USDC",
  environment: "dev",
  reviewerVerdict: "approve",
  reviewerRiskLevel: "low",
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? JSON.parse(text) : null;
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeEach(async () => {
  healthStatus = 200;
  evaluationStatus = 200;
  evaluationBody = {
    result: {
      decision: "needs_human",
      requires_human_approval: true,
      matched_allow_rules: ["allowlist_match"],
      matched_deny_rules: [],
      escalation_reasons: [
        { rule: "notional_above_auto_threshold", message: "Notional too high." },
      ],
    },
  };
  stallEvaluation = false;
  stallEvaluationBody = false;
  requests.length = 0;
  server = createServer(async (req, res) => {
    const body = await readJson(req);
    requests.push({ method: req.method ?? "", url: req.url ?? "", body });

    if (req.method === "GET" && (req.url === "/health" || req.url === "/opa/health")) {
      writeJson(res, healthStatus, { healthy: healthStatus === 200 });
      return;
    }

    if (
      req.method === "POST" &&
      (req.url === "/v1/data/guardrail" || req.url === "/opa/v1/data/guardrail")
    ) {
      if (stallEvaluation) return;
      if (stallEvaluationBody) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        return;
      }
      writeJson(res, evaluationStatus, evaluationBody);
      return;
    }

    writeJson(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not bind.");
  opaUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("OpaHttpPolicyEvaluator", () => {
  it("posts policy input to OPA and returns transformed PolicyOutput", async () => {
    const evaluator = new OpaHttpPolicyEvaluator({ opaUrl });

    const output = await evaluator.evaluate(policyInput);

    expect(output).toMatchObject({
      decision: "needs_human",
      requiresHumanApproval: true,
      matchedAllowRules: ["allowlist_match"],
      matchedDenyRules: [],
      reasons: [{ rule: "notional_above_auto_threshold", message: "Notional too high." }],
    });
    expect(output.evaluatedAt).toBeTruthy();
    expect(requests[0]).toEqual({
      method: "POST",
      url: "/v1/data/guardrail",
      body: { input: policyInput },
    });
  });

  it("preserves path prefixes in the configured OPA URL", async () => {
    const evaluator = new OpaHttpPolicyEvaluator({ opaUrl: `${opaUrl}/opa` });

    await evaluator.evaluate(policyInput);
    await expect(evaluator.isHealthy()).resolves.toBe(true);

    expect(requests.map((request) => request.url)).toEqual([
      "/opa/v1/data/guardrail",
      "/opa/health",
    ]);
  });

  it("checks OPA health via the configured URL", async () => {
    const evaluator = new OpaHttpPolicyEvaluator({ opaUrl });

    await expect(evaluator.isHealthy()).resolves.toBe(true);
    healthStatus = 204;
    await expect(evaluator.isHealthy()).resolves.toBe(false);
    healthStatus = 503;
    await expect(evaluator.isHealthy()).resolves.toBe(false);

    expect(requests.map((request) => request.url)).toEqual(["/health", "/health", "/health"]);
  });

  it("fails closed on OPA evaluation HTTP failures", async () => {
    evaluationStatus = 500;
    const evaluator = new OpaHttpPolicyEvaluator({ opaUrl });

    await expect(evaluator.evaluate(policyInput)).rejects.toThrow("HTTP 500");
  });

  it("fails closed when OPA omits an object result", async () => {
    evaluationBody = { result: null };
    const evaluator = new OpaHttpPolicyEvaluator({ opaUrl });

    await expect(evaluator.evaluate(policyInput)).rejects.toThrow("object result");
  });

  it("fails closed when transformed OPA output is invalid", async () => {
    evaluationBody = { result: { decision: "allow", requires_human_approval: true } };
    const evaluator = new OpaHttpPolicyEvaluator({ opaUrl });

    await expect(evaluator.evaluate(policyInput)).rejects.toThrow();
  });

  it("times out stalled OPA evaluation requests", async () => {
    stallEvaluation = true;
    const evaluator = new OpaHttpPolicyEvaluator({ opaUrl, timeoutMs: 10 });

    await expect(evaluator.evaluate(policyInput)).rejects.toThrow();
  });

  it("times out stalled OPA response bodies", async () => {
    stallEvaluationBody = true;
    const evaluator = new OpaHttpPolicyEvaluator({ opaUrl, timeoutMs: 10 });

    await expect(evaluator.evaluate(policyInput)).rejects.toThrow();
  });

  it("rejects invalid timeout configuration", () => {
    expect(() => new OpaHttpPolicyEvaluator({ opaUrl, timeoutMs: 0 })).toThrow("32-bit");
    expect(() => new OpaHttpPolicyEvaluator({ opaUrl, timeoutMs: 2_147_483_648 })).toThrow(
      "32-bit",
    );
  });
});
