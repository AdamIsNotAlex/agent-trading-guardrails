import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stackIntent, startAcceptanceStack } from "../../runtime/dist/stack-test-harness.js";
import { HermesAgentAdapter } from "./hermes-adapter.js";
import { GuardrailEvaluateClient } from "./http-client.js";
import { OpenClawAdapter } from "./openclaw-adapter.js";

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

describe("Agent adapters -> standalone Guardrail -> independent paper Broker", () => {
  it.each([
    OpenClawAdapter,
    HermesAgentAdapter,
  ])("authorizes and executes %s proposals through the real stack", async (Adapter) => {
    const principal = "agent.acceptance.adapter";
    const adapter = new Adapter(
      new GuardrailEvaluateClient({ baseUrl: stack.url }),
      principal,
      "dev",
    );
    const intent = stackIntent({ principal });
    const decision = await adapter.executeTool("propose_order", intent);
    expect(decision).toMatchObject({ success: true, outcome: "allow", intentId: intent.intentId });
    const response = await stack.execute(decision);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "executed",
      orderId: expect.stringMatching(/^paper-/),
      revalidationPassed: true,
    });
    expect(
      stack
        .audit()
        .filter((row) => row.intent_id === intent.intentId)
        .map((row) => row.event_type),
    ).toEqual([
      "intent.received",
      "reviewer.completed",
      "risk.evaluated",
      "policy.evaluated",
      "decision.final",
    ]);
  });

  it("runs the actual JSONL Agent entrypoint without service secrets", async () => {
    const intent = stackIntent();
    const decision = await stack.agent(intent);
    expect(decision).toMatchObject({
      outcome: "allow",
      intentId: intent.intentId,
      riskResult: { passed: true },
    });
    expect(await (await stack.execute({ ...decision, intent })).json()).toMatchObject({
      status: "executed",
      executionKind: "cex_order",
    });
  });

  it("preserves signed approval binding across HTTP replay and shared-store consumption", async () => {
    stack.mode.policy = "needs_human";
    const intent = stackIntent();
    const first = await stack.evaluate(intent);
    const replay = await stack.evaluate(intent);
    expect(first.outcome).toBe("needs_human");
    expect(replay).toEqual(first);
    expect(
      stack.approvals().filter((request) => request.intentId === intent.intentId),
    ).toMatchObject([
      { approvalId: first.approvalId, correlationId: first.correlationId, state: "pending" },
    ]);
    const client = new GuardrailEvaluateClient({ baseUrl: stack.url });
    expect(await client.evaluate(intent)).toMatchObject({
      ok: true,
      decision: first,
      correlationId: first.correlationId,
    });
    const signed = { ...replay, intent };
    expect(await (await stack.execute(signed)).json()).toMatchObject({ status: "rejected" });
    if (!first.approvalId) throw new Error("Missing approval binding");
    expect(stack.approve(first.approvalId)?.state).toBe("approved");
    const executed = await (await stack.execute(signed)).json();
    expect(executed).toMatchObject({
      status: "executed",
      orderId: expect.stringMatching(/^paper-/),
    });
    expect(await (await stack.execute(signed)).json()).toEqual(executed);
    expect(
      stack.approvals().find((request) => request.approvalId === first.approvalId)?.state,
    ).toBe("consumed");
  });

  it("fails closed at the adapter when the policy HTTP endpoint fails", async () => {
    stack.mode.policy = "unavailable";
    const adapter = new HermesAgentAdapter(
      new GuardrailEvaluateClient({ baseUrl: stack.url }),
      "agent.acceptance.failure",
      "dev",
    );
    const intent = stackIntent();
    const decision = await adapter.executeTool("propose_order", intent);
    expect(decision).toMatchObject({
      success: false,
      outcome: "deny",
      reasons: [{ rule: "policy_evaluation_failed" }],
    });
    expect(decision.decisionToken).toBeUndefined();
    expect(stack.approvals().some((request) => request.intentId === intent.intentId)).toBe(false);
    expect(stack.audit("broker").some((row) => row.intent_id === intent.intentId)).toBe(false);
  });
});
