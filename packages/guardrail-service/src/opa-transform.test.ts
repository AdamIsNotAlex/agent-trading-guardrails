import { describe, expect, it } from "vitest";
import { transformOpaOutput } from "./opa-transform.js";

const evaluatedAt = "2026-05-04T12:00:00.000Z";

describe("transformOpaOutput", () => {
  it("maps snake_case OPA allow output to PolicyOutput", () => {
    const output = transformOpaOutput({
      decision: "allow",
      reasons: [],
      requires_human_approval: false,
      matched_allow_rules: ["allow-binance-spot"],
      matched_deny_rules: [],
      evaluatedAt,
    });

    expect(output).toEqual({
      decision: "allow",
      reasons: [],
      requiresHumanApproval: false,
      matchedAllowRules: ["allow-binance-spot"],
      matchedDenyRules: [],
      evaluatedAt,
    });
  });

  it("combines hard deny reasons into reasons", () => {
    const output = transformOpaOutput({
      decision: "deny",
      requires_human_approval: false,
      matched_allow_rules: [],
      matched_deny_rules: ["deny-bridge"],
      hard_deny_reasons: [{ rule: "deny-bridge", message: "Bridge transactions are denied." }],
      evaluatedAt,
    });

    expect(output.reasons).toEqual([
      { rule: "deny-bridge", message: "Bridge transactions are denied." },
    ]);
    expect(output.matchedDenyRules).toEqual(["deny-bridge"]);
  });

  it("does not duplicate direct Rego reasons", () => {
    const output = transformOpaOutput({
      decision: "deny",
      reasons: [{ rule: "deny-bridge", message: "Bridge transactions are denied." }],
      requires_human_approval: false,
      matched_allow_rules: [],
      matched_deny_rules: ["deny-bridge"],
      hard_deny_reasons: [{ rule: "deny-bridge", message: "Bridge transactions are denied." }],
      evaluatedAt,
    });

    expect(output.reasons).toEqual([
      { rule: "deny-bridge", message: "Bridge transactions are denied." },
    ]);
  });

  it("combines escalation reasons and marks needs_human output", () => {
    const output = transformOpaOutput({
      decision: "needs_human",
      requires_human_approval: true,
      matched_allow_rules: ["allow-with-approval"],
      matched_deny_rules: [],
      escalation_reasons: ["daily_notional_limit"],
      evaluatedAt,
    });

    expect(output.requiresHumanApproval).toBe(true);
    expect(output.reasons).toEqual([
      { rule: "daily_notional_limit", message: "daily_notional_limit" },
    ]);
  });

  it("injects evaluatedAt when OPA output omits it", () => {
    const output = transformOpaOutput({
      decision: "allow",
      reasons: [],
      requires_human_approval: false,
      matched_allow_rules: ["allow-binance-spot"],
      matched_deny_rules: [],
    });

    expect(new Date(output.evaluatedAt).toString()).not.toBe("Invalid Date");
  });
});
