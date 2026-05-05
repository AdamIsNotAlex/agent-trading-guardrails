import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonFileAllowlistOnboardingStore } from "./allowlist-store.js";
import { ApprovalCli } from "./cli.js";
import type { AllowlistOnboardingEntry, ApprovalAuditWriter } from "./interfaces.js";
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
  environment: "canary_live" as const,
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

  it("persists allowlist onboarding approvals and emits audit events", () => {
    const allowlistPath = join(mkdtempSync(join(tmpdir(), "allowlist-")), "allowlist.json");
    const auditEvents: Parameters<ApprovalAuditWriter["write"]>[0][] = [];
    const store = new ApprovalStore({
      defaultTimeoutSeconds: 300,
      allowlistOnboarding: {
        store: new JsonFileAllowlistOnboardingStore(allowlistPath),
        audit: { write: (event) => auditEvents.push(event) },
      },
    });
    const req = store.create({ ...baseParams, approvalType: "allowlist_onboarding" });

    const approved = store.approve(req.approvalId, "admin");
    const entries = JSON.parse(readFileSync(allowlistPath, "utf8")) as AllowlistOnboardingEntry[];

    expect(approved?.approvalType).toBe("allowlist_onboarding");
    expect(entries).toMatchObject([
      {
        effect: "allow",
        principal: baseParams.principal,
        action: baseParams.action,
        resource: baseParams.resource,
        condition: {
          environment: baseParams.environment,
          maxNotionalUsd: baseParams.intentData.maxNotionalUsd,
          requiresHumanApproval: false,
        },
      },
    ]);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      eventType: "allowlist.updated",
      environment: baseParams.environment,
      intentId: baseParams.intentId,
      principal: baseParams.principal,
      correlationId: baseParams.correlationId,
      data: { updatedBy: "admin", policyEntry: entries[0] },
    });
  });

  it("rolls back allowlist persistence when audit emission fails", () => {
    const allowlistPath = join(mkdtempSync(join(tmpdir(), "allowlist-")), "allowlist.json");
    const store = new ApprovalStore({
      defaultTimeoutSeconds: 300,
      allowlistOnboarding: {
        store: new JsonFileAllowlistOnboardingStore(allowlistPath),
        audit: {
          write() {
            throw new Error("audit unavailable");
          },
        },
      },
    });
    const req = store.create({ ...baseParams, approvalType: "allowlist_onboarding" });

    expect(() => store.approve(req.approvalId, "admin")).toThrow("audit unavailable");
    expect(JSON.parse(readFileSync(allowlistPath, "utf8"))).toEqual([]);
    expect(store.get(req.approvalId)?.state).toBe("pending");
  });

  it("fails closed when allowlist onboarding persistence is not configured", () => {
    const store = makeStore();
    const req = store.create({ ...baseParams, approvalType: "allowlist_onboarding" });

    expect(() => store.approve(req.approvalId, "admin")).toThrow("not configured");
    expect(store.get(req.approvalId)?.state).toBe("pending");
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
