import { binanceCancelOrder, binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { describe, expect, it, vi } from "vitest";
import type { KillSwitchScope } from "./interfaces.js";
import { InMemoryKillSwitch } from "./kill-switch.js";
import { LiveModePreflightCheck, type LiveModePreflightCheckParams } from "./preflight.js";

function run(overrides: Partial<LiveModePreflightCheckParams> = {}) {
  return new LiveModePreflightCheck({
    audit: { write() {}, checkHealth() {} },
    killSwitch: new InMemoryKillSwitch(),
    approvalStore: { liveConfigured: () => true, checkHealth() {} },
    environment: "canary_live",
    intent: binanceSpotOrder,
    correlationId: "preflight",
    ...overrides,
  }).run();
}

describe("live preflight failures", () => {
  const scopes: KillSwitchScope[] = [
    { type: "global" },
    { type: "agent", principal: binanceSpotOrder.principal },
    { type: "account", account: binanceSpotOrder.account },
    { type: "exchange", exchange: binanceSpotOrder.exchange },
  ];
  it.each(scopes)("blocks an active $type scope", (scope) => {
    const killSwitch = new InMemoryKillSwitch();
    killSwitch.activate(scope);
    const result = run({ killSwitch });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.check === "kill_switch")?.passed).toBe(false);
  });

  it.each([
    binanceSpotOrder,
    binanceCancelOrder,
  ])("fails closed on unknown kill state for $action without exposing backend details", (intent) => {
    const killSwitch = new InMemoryKillSwitch();
    const read = vi.spyOn(killSwitch, "isActive").mockReturnValue(undefined as unknown as boolean);
    expect(run({ killSwitch, intent }).passed).toBe(false);
    read.mockImplementation(() => {
      throw new Error("sensitive-backend-detail");
    });
    const failed = run({ killSwitch, intent });
    expect(failed.passed).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("sensitive-backend-detail");
    read.mockRestore();
  });

  it("blocks missing/unhealthy audit probes and a failed summary write", () => {
    for (const audit of [
      { write() {} },
      {
        write() {},
        checkHealth() {
          throw new Error("unwritable");
        },
      },
      {
        write() {
          throw new Error("summary failure");
        },
        checkHealth() {},
      },
    ]) {
      const result = run({ audit });
      expect(result.passed).toBe(false);
      expect(result.checks.find((check) => check.check === "audit")?.passed).toBe(false);
    }
    const invalidCorrelation = run({ correlationId: "" });
    expect(invalidCorrelation.passed).toBe(false);
    expect(invalidCorrelation.checks.find((check) => check.check === "audit")?.passed).toBe(false);
  });

  it("requires an explicitly configured and accessible approval store", () => {
    for (const approvalStore of [
      undefined,
      { checkHealth() {} },
      {
        liveConfigured: () => false,
        checkHealth() {
          throw new Error("must not probe");
        },
      },
      {
        liveConfigured: () => true,
        checkHealth() {
          throw new Error("store failure");
        },
      },
    ]) {
      const result = run({ approvalStore });
      expect(result.passed).toBe(false);
      expect(result.checks.find((check) => check.check === "approval")?.passed).toBe(false);
    }
  });
});
