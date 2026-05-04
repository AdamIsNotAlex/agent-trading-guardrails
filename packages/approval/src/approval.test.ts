import { describe, expect, it } from "vitest";
import { ApprovalCli } from "./cli.js";
import { ApprovalStore } from "./store.js";

function makeStore(timeoutSeconds = 300) {
  return new ApprovalStore({ defaultTimeoutSeconds: timeoutSeconds });
}

const baseParams = {
  intentId: "intent-001",
  correlationId: "corr-001",
  principal: "agent.openclaw.alpha",
  action: "cex.place_order",
  resource: "cex:binance:sub:ETH-USDC",
  environment: "canary_live",
  escalationReason: "Notional above auto threshold.",
  approvalType: "one_time" as const,
  intentData: { symbol: "ETH-USDC", maxNotionalUsd: 20 },
};

describe("ApprovalStore", () => {
  it("creates pending approval request", () => {
    const store = makeStore();
    const req = store.create(baseParams);
    expect(req.state).toBe("pending");
    expect(req.approvalId).toBeTruthy();
    expect(req.decidedAt).toBeNull();
  });

  it("lists all requests", () => {
    const store = makeStore();
    store.create(baseParams);
    store.create({ ...baseParams, intentId: "intent-002" });
    expect(store.list()).toHaveLength(2);
  });

  it("filters by state", () => {
    const store = makeStore();
    const req = store.create(baseParams);
    store.approve(req.approvalId, "operator");
    store.create({ ...baseParams, intentId: "intent-002" });
    expect(store.list({ state: "pending" })).toHaveLength(1);
    expect(store.list({ state: "approved" })).toHaveLength(1);
  });

  it("approves pending request", () => {
    const store = makeStore();
    const req = store.create(baseParams);
    const result = store.approve(req.approvalId, "operator-1");
    expect(result).not.toBeNull();
    expect(result?.state).toBe("approved");
    expect(result?.decidedBy).toBe("operator-1");
    expect(result?.decidedAt).toBeTruthy();
  });

  it("denies pending request", () => {
    const store = makeStore();
    const req = store.create(baseParams);
    const result = store.deny(req.approvalId, "operator-1");
    expect(result).not.toBeNull();
    expect(result?.state).toBe("denied");
  });

  it("cannot approve already-decided request", () => {
    const store = makeStore();
    const req = store.create(baseParams);
    store.deny(req.approvalId, "op");
    expect(store.approve(req.approvalId, "op")).toBeNull();
  });

  it("times out expired requests", () => {
    const store = new ApprovalStore({ defaultTimeoutSeconds: -1 });
    store.create(baseParams);
    const timedOut = store.checkTimeouts();
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0].state).toBe("timeout");
  });

  it("cannot approve timed-out request", () => {
    const store = new ApprovalStore({ defaultTimeoutSeconds: -1 });
    const req = store.create(baseParams);
    store.checkTimeouts();
    expect(store.approve(req.approvalId, "op")).toBeNull();
  });

  it("supports allowlist onboarding type", () => {
    const store = makeStore();
    const req = store.create({ ...baseParams, approvalType: "allowlist_onboarding" });
    expect(req.approvalType).toBe("allowlist_onboarding");
    const approved = store.approve(req.approvalId, "admin");
    expect(approved?.approvalType).toBe("allowlist_onboarding");
  });

  it("does not require interactive terminal for creation", () => {
    const store = makeStore();
    const req = store.create(baseParams);
    expect(req.state).toBe("pending");
  });
});

describe("ApprovalCli", () => {
  it("lists pending approvals", () => {
    const store = makeStore();
    store.create(baseParams);
    const cli = new ApprovalCli(store);
    const output = cli.list();
    expect(output).toContain("PENDING");
    expect(output).toContain("cex.place_order");
  });

  it("shows approval details", () => {
    const store = makeStore();
    const req = store.create(baseParams);
    const cli = new ApprovalCli(store);
    const output = cli.show(req.approvalId);
    expect(output).toContain(req.approvalId);
    expect(output).toContain("pending");
  });

  it("approves via CLI", () => {
    const store = makeStore();
    const req = store.create(baseParams);
    const cli = new ApprovalCli(store);
    const output = cli.approve(req.approvalId, "admin");
    expect(output).toContain("Approved");
  });

  it("denies via CLI", () => {
    const store = makeStore();
    const req = store.create(baseParams);
    const cli = new ApprovalCli(store);
    const output = cli.deny(req.approvalId, "admin");
    expect(output).toContain("Denied");
  });

  it("handles not-found", () => {
    const cli = new ApprovalCli(makeStore());
    expect(cli.show("nonexistent")).toContain("not found");
  });

  it("live execution cannot bypass required approval", () => {
    const store = makeStore();
    const req = store.create(baseParams);
    expect(req.state).toBe("pending");
    expect(store.get(req.approvalId)?.state).toBe("pending");
  });
});
