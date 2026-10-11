import { request } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  stackIntent,
  stackSecrets,
  startAcceptanceStack,
} from "../../runtime/dist/stack-test-harness.js";
import { hallucinatedClaims, promptInjectionPayloads } from "./fixtures.js";

let stack: Awaited<ReturnType<typeof startAcceptanceStack>>;
beforeAll(async () => {
  stack = await startAcceptanceStack();
});
afterAll(async () => {
  await stack?.close();
});
beforeEach(async () => {
  Object.assign(stack.mode, { reviewer: "approve", policy: "allow", opaHealthy: true });
  await stack.freshRisk();
});

describe("HTTP red-team against standalone production components", () => {
  it.each([
    [promptInjectionPayloads.webpageInstruction, "prompt_injection_detected"],
    [promptInjectionPayloads.mcpToolDefinition, "prompt_injection_detected"],
    [promptInjectionPayloads.secretExfiltrationLog, "prompt_injection_detected"],
    [hallucinatedClaims.fakeBalance, "hallucinated_data_detected"],
    [hallucinatedClaims.fakePosition, "hallucinated_data_detected"],
  ])("denies %s without granting execution or leaking seeded secrets", async (rationale, rule) => {
    const intent = stackIntent({ rationale });
    const decision = await stack.evaluate(intent);
    expect(decision).toMatchObject({
      outcome: "deny",
      requiresHumanApproval: false,
      reasons: [{ rule }],
    });
    expect(decision.decisionToken).toBeUndefined();
    expect(stack.approvals().some((approval) => approval.intentId === intent.intentId)).toBe(false);
    expect(stack.audit("broker").some((row) => row.intent_id === intent.intentId)).toBe(false);
    const audit = stack.audit().filter((row) => row.intent_id === intent.intentId);
    expect(audit.map((row) => row.event_type)).toEqual(["intent.received", "decision.final"]);
    const output = JSON.stringify({ decision, audit, logs: stack.logs() });
    for (const secret of Object.values(stackSecrets)) expect(output).not.toContain(secret);
  });

  it.each([
    ["malformed JSON", "{", "application/json", 400],
    ["invalid intent", "{}", "application/json", 400],
    ["wrong content type", "{}", "text/plain", 415],
    ["oversized declared body", "x".repeat(1_048_577), "application/json", 413],
  ])("rejects %s before audit, approval or execution side effects", async (_label, body, contentType, status) => {
    const before = stack.audit();
    const response = await fetch(`${stack.url}/evaluate`, {
      method: "POST",
      headers: { "content-type": contentType, "x-correlation-id": "redteam-request" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("x-correlation-id")).toBe("redteam-request");
    expect(await response.json()).toMatchObject({ correlationId: "redteam-request" });
    expect(stack.audit()).toEqual(before);
  });

  it("bounds chunked bodies even without a Content-Length header", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${stack.url}/evaluate`,
        { method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode));
        },
      );
      // Real TCP/child-process watchdog, not a sleep; completion awaits the response end event.
      req.setTimeout(5000, () => req.destroy(new Error("HTTP body limit probe timed out")));
      req.once("error", reject);
      for (let index = 0; index < 17; index++) req.write("x".repeat(65536));
      req.end();
    });
    expect(status).toBe(413);
  });

  it.each([
    "malformed",
    "unavailable",
  ] as const)("denies %s reviewer responses over the real SDK transport", async (mode) => {
    stack.mode.reviewer = mode;
    const decision = await stack.evaluate(stackIntent());
    expect(decision).toMatchObject({
      outcome: "deny",
      reasons: [{ rule: "reviewer_unavailable" }],
    });
    expect(decision.decisionToken).toBeUndefined();
    expect(decision.approvalId).toBeUndefined();
  });

  it.each([
    "malformed",
    "unavailable",
  ] as const)("rejects %s OPA output even after advisory approval", async (mode) => {
    stack.mode.policy = mode;
    const decision = await stack.evaluate(stackIntent());
    expect(decision).toMatchObject({
      outcome: "deny",
      reviewerVerdict: { verdict: "approve" },
      reasons: [{ rule: "policy_evaluation_failed" }],
    });
    expect(decision.decisionToken).toBeUndefined();
    expect(decision.approvalId).toBeUndefined();
  });

  it("does not let an approving reviewer override policy denial", async () => {
    stack.mode.policy = "deny";
    const decision = await stack.evaluate(stackIntent());
    expect(decision).toMatchObject({
      outcome: "deny",
      reviewerVerdict: { verdict: "approve" },
      reasons: [{ rule: "fixture_hard_deny" }],
      requiresHumanApproval: false,
    });
    expect(decision.approvalId).toBeUndefined();
    expect(decision.decisionToken).toBeUndefined();
  });

  it("denies stale trusted risk facts despite permissive reviewer and policy infrastructure", async () => {
    await stack.freshRisk(60_000);
    const decision = await stack.evaluate(stackIntent());
    expect(decision).toMatchObject({
      outcome: "deny",
      riskResult: { passed: false },
      policyOutput: null,
    });
    expect(decision.reasons.some((reason) => reason.rule.startsWith("risk_"))).toBe(true);
    expect(decision.decisionToken).toBeUndefined();
  });

  it("rejects forged or rebound decisions before and after a legitimate paper execution", async () => {
    const intent = stackIntent();
    const decision = await stack.evaluate(intent);
    expect(decision.outcome).toBe("allow");
    const approval = { ...decision, intent };
    const forged = { ...approval, decisionToken: "0".repeat(64) };
    const rebound = { ...approval, intent: { ...intent, quantity: 0.001 } };
    for (const body of [forged, rebound]) {
      const response = await stack.execute(body);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ status: "rejected", revalidationPassed: false });
      expect(result).not.toHaveProperty("orderId");
    }
    expect(
      stack
        .audit("broker")
        .filter((row) => row.intent_id === intent.intentId && row.event_type === "broker.executed"),
    ).toEqual([]);
    expect(await (await stack.execute(approval)).json()).toMatchObject({ status: "executed" });
    expect(await (await stack.execute(forged)).json()).toMatchObject({ status: "rejected" });
  });
});
