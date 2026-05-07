import { describe, expect, it } from "vitest";
import { transformOpaOutput } from "./opa-transform.js";

const evaluatedAt = "2026-05-04T12:00:00.000Z";

describe("transformOpaOutput", () => {
  it("maps snake_case OPA allow output to PolicyOutput", () => {
    const output = transformOpaOutput({
      decision: "allow",
      reasons: [{ rule: "allow-binance-spot", message: "Allowed." }],
      requires_human_approval: false,
      matched_allow_rules: ["allow-binance-spot"],
      matched_deny_rules: [],
      evaluatedAt,
    });

    expect(output).toEqual({
      decision: "allow",
      reasons: [{ rule: "allow-binance-spot", message: "Allowed." }],
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
      reasons: [{ rule: "allow-binance-spot", message: "Allowed." }],
      requires_human_approval: false,
      matched_allow_rules: ["allow-binance-spot"],
      matched_deny_rules: [],
    });

    expect(new Date(output.evaluatedAt).toString()).not.toBe("Invalid Date");
  });

  it("rejects partial allow output", () => {
    expect(() => transformOpaOutput({ decision: "allow" })).toThrow();
  });

  it("rejects output missing requires_human_approval", () => {
    expect(() =>
      transformOpaOutput({
        decision: "allow",
        reasons: [],
        matched_allow_rules: ["allow-binance-spot"],
        matched_deny_rules: [],
        evaluatedAt,
      }),
    ).toThrow();
  });

  it("rejects output missing matched rule arrays", () => {
    expect(() =>
      transformOpaOutput({
        decision: "deny",
        reasons: [{ rule: "default_deny", message: "Default deny." }],
        requires_human_approval: false,
        evaluatedAt,
      }),
    ).toThrow();
  });

  it("rejects allow output without allow evidence", () => {
    expect(() =>
      transformOpaOutput({
        decision: "allow",
        reasons: [],
        requires_human_approval: false,
        matched_allow_rules: [],
        matched_deny_rules: [],
        evaluatedAt,
      }),
    ).toThrow();
  });

  it("rejects allow output without allow reasons", () => {
    expect(() =>
      transformOpaOutput({
        decision: "allow",
        reasons: [],
        requires_human_approval: false,
        matched_allow_rules: ["allow-binance-spot"],
        matched_deny_rules: [],
        evaluatedAt,
      }),
    ).toThrow("allow decision requires at least one allow reason");
  });

  it("rejects allow output with deny reasons but no matched allow rule", () => {
    expect(() =>
      transformOpaOutput({
        decision: "allow",
        reasons: [{ rule: "default_deny", message: "Default deny." }],
        requires_human_approval: false,
        matched_allow_rules: [],
        matched_deny_rules: [],
        evaluatedAt,
      }),
    ).toThrow();
  });

  it("rejects allow output with matched deny rule evidence", () => {
    expect(() =>
      transformOpaOutput({
        decision: "allow",
        reasons: [{ rule: "allow-binance-spot", message: "Allowed." }],
        requires_human_approval: false,
        matched_allow_rules: ["allow-binance-spot"],
        matched_deny_rules: ["withdrawal_denied"],
        evaluatedAt,
      }),
    ).toThrow("non-deny decision cannot include hard-deny evidence");
  });

  it("rejects allow output with escalation evidence", () => {
    expect(() =>
      transformOpaOutput({
        decision: "allow",
        reasons: [{ rule: "allow-binance-spot", message: "Allowed." }],
        escalation_reasons: [{ rule: "daily_notional_limit", message: "Daily notional exceeded." }],
        requires_human_approval: false,
        matched_allow_rules: ["allow-binance-spot"],
        matched_deny_rules: [],
        evaluatedAt,
      }),
    ).toThrow("allow decision cannot include escalation evidence");
  });

  it("rejects needs_human output with hard deny evidence", () => {
    expect(() =>
      transformOpaOutput({
        decision: "needs_human",
        reasons: [{ rule: "daily_notional_limit", message: "daily_notional_limit" }],
        hard_deny_reasons: [{ rule: "withdrawal_denied", message: "Withdrawals denied." }],
        requires_human_approval: true,
        matched_allow_rules: [],
        matched_deny_rules: [],
        evaluatedAt,
      }),
    ).toThrow("non-deny decision cannot include hard-deny evidence");
  });

  it("rejects allow output with deny reasons despite matched allow evidence", () => {
    expect(() =>
      transformOpaOutput({
        decision: "allow",
        reasons: [{ rule: "default_deny", message: "Default deny." }],
        requires_human_approval: false,
        matched_allow_rules: ["allow-binance-spot"],
        matched_deny_rules: [],
        evaluatedAt,
      }),
    ).toThrow("allow decision reasons must match allow rule evidence");
  });

  it("rejects needs_human output without human approval flag", () => {
    expect(() =>
      transformOpaOutput({
        decision: "needs_human",
        reasons: [{ rule: "daily_notional_limit", message: "daily_notional_limit" }],
        escalation_reasons: ["daily_notional_limit"],
        requires_human_approval: false,
        matched_allow_rules: [],
        matched_deny_rules: [],
        evaluatedAt,
      }),
    ).toThrow();
  });

  it("rejects needs_human output with reasons outside escalation evidence", () => {
    expect(() =>
      transformOpaOutput({
        decision: "needs_human",
        reasons: [{ rule: "unrelated", message: "Unrelated." }],
        escalation_reasons: ["daily_notional_limit"],
        requires_human_approval: true,
        matched_allow_rules: [],
        matched_deny_rules: [],
        evaluatedAt,
      }),
    ).toThrow("needs_human decision reasons must match escalation evidence");
  });
});
