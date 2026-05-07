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
    expect(result?.decidedBy).toBe("operator-1");
    expect(result?.decidedAt).toBeTruthy();
  });

  it("emits approval decision and timeout audit events", () => {
    const auditEvents: Parameters<ApprovalAuditWriter["write"]>[0][] = [];
    const approvedStore = new ApprovalStore({
      defaultTimeoutSeconds: 300,
      audit: { write: (event) => auditEvents.push(event) },
    });
    const deniedStore = new ApprovalStore({
      defaultTimeoutSeconds: 300,
      audit: { write: (event) => auditEvents.push(event) },
    });
    const timeoutStore = new ApprovalStore({
      defaultTimeoutSeconds: -1,
      audit: { write: (event) => auditEvents.push(event) },
    });

    approvedStore.approve(approvedStore.create(baseParams).approvalId, "operator-1");
    deniedStore.deny(deniedStore.create(baseParams).approvalId, "operator-2");
    timeoutStore.create(baseParams);
    const timedOut = timeoutStore.checkTimeouts()[0];

    expect(auditEvents.map((event) => event.eventType)).toEqual([
      "approval.approved",
      "approval.denied",
      "approval.timeout",
    ]);
    expect(auditEvents[0].data).toMatchObject({ decidedBy: "operator-1", state: "approved" });
    expect(auditEvents[1].data).toMatchObject({ decidedBy: "operator-2", state: "denied" });
    expect(auditEvents[2].data).toMatchObject({
      decidedAt: timedOut?.decidedAt,
      decidedBy: null,
      state: "timeout",
    });
  });

  it("cannot approve already-decided request", () => {
    const store = makeStore();
    const req = store.create(baseParams);
    store.deny(req.approvalId, "op");
    expect(store.approve(req.approvalId, "op")).toBeNull();
  });

  it("keeps approval pending when approval audit emission fails", () => {
    const store = new ApprovalStore({
      defaultTimeoutSeconds: 300,
      audit: {
        write() {
          throw new Error("audit unavailable");
        },
      },
    });
    const req = store.create(baseParams);

    expect(() => store.approve(req.approvalId, "operator")).toThrow("audit unavailable");
    expect(store.get(req.approvalId)?.state).toBe("pending");
  });

  it("times out expired requests", () => {
    const store = new ApprovalStore({ defaultTimeoutSeconds: -1 });
    store.create(baseParams);
    const timedOut = store.checkTimeouts();
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0].state).toBe("timeout");
    expect(timedOut[0].decidedAt).toBeTruthy();
    expect(timedOut[0].decidedBy).toBeNull();
  });

  it("cannot approve timed-out request", () => {
    const store = new ApprovalStore({ defaultTimeoutSeconds: -1 });
    const req = store.create(baseParams);
    store.checkTimeouts();
    expect(store.approve(req.approvalId, "op")).toBeNull();
  });

  it("rejects wait when approval has already been consumed", async () => {
    const store = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const req = store.create(baseParams);
    store.approve(req.approvalId, "operator");
    store.consumeOneTime(req.approvalId);

    await expect(store.waitForApproval(req.approvalId, 10)).rejects.toThrow("already used");
  });

  it("preserves approval decision provenance when consumed", () => {
    const store = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const req = store.create(baseParams);
    const approved = store.approve(req.approvalId, "operator");
    const consumed = store.consumeOneTime(req.approvalId);

    expect(consumed).not.toBeNull();
    expect(consumed?.state).toBe("consumed");
    expect(consumed?.decidedAt).toBe(approved?.decidedAt);
    expect(consumed?.decidedBy).toBe("operator");
  });

  it("does not erase approval provenance when approved request expires before consumption", () => {
    const store = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const req = store.create(baseParams);
    const approved = store.approve(req.approvalId, "operator");
    if (!approved) throw new Error("approval failed");
    approved.timeoutAt = new Date(Date.now() - 1_000).toISOString();

    const consumed = store.consumeOneTime(req.approvalId);

    expect(consumed).toBeNull();
    expect(store.get(req.approvalId)).toMatchObject({
      state: "approved",
      decidedAt: approved.decidedAt,
      decidedBy: "operator",
    });
  });

  it("wait rejects expired approved requests without rewriting approval metadata", async () => {
    const store = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const req = store.create(baseParams);
    const approved = store.approve(req.approvalId, "operator");
    if (!approved) throw new Error("approval failed");
    approved.timeoutAt = new Date(Date.now() - 1_000).toISOString();

    await expect(store.waitForApproval(req.approvalId, 10)).rejects.toThrow("timed out");

    expect(store.get(req.approvalId)).toMatchObject({
      state: "approved",
      decidedAt: approved.decidedAt,
      decidedBy: "operator",
    });
  });

  it("rejects wait when timeout audit fails", async () => {
    const store = new ApprovalStore({
      defaultTimeoutSeconds: -1,
      audit: {
        write() {
          throw new Error("audit unavailable");
        },
      },
    });
    const req = store.create(baseParams);

    await expect(store.waitForApproval(req.approvalId, 10)).rejects.toThrow("audit unavailable");
    expect(store.get(req.approvalId)?.state).toBe("pending");
  });

  it("emits timeout audit when deny discovers expiration", () => {
    const auditEvents: Parameters<ApprovalAuditWriter["write"]>[0][] = [];
    const store = new ApprovalStore({
      defaultTimeoutSeconds: -1,
      audit: { write: (event) => auditEvents.push(event) },
    });
    const req = store.create(baseParams);

    expect(store.deny(req.approvalId, "op")).toBeNull();

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      eventType: "approval.timeout",
      data: { state: "timeout" },
    });
  });

  it("emits timeout audit when approve discovers expiration", () => {
    const auditEvents: Parameters<ApprovalAuditWriter["write"]>[0][] = [];
    const store = new ApprovalStore({
      defaultTimeoutSeconds: -1,
      audit: { write: (event) => auditEvents.push(event) },
    });
    const req = store.create(baseParams);

    expect(store.approve(req.approvalId, "op")).toBeNull();

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      eventType: "approval.timeout",
      data: { state: "timeout" },
    });
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
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0]).toMatchObject({
      eventType: "allowlist.updated",
      environment: baseParams.environment,
      intentId: baseParams.intentId,
      principal: baseParams.principal,
      correlationId: baseParams.correlationId,
      data: { updatedBy: "admin", policyEntry: entries[0] },
    });
    expect(auditEvents[1]).toMatchObject({
      eventType: "approval.approved",
      environment: baseParams.environment,
      intentId: baseParams.intentId,
      principal: baseParams.principal,
      correlationId: baseParams.correlationId,
      data: { decidedBy: "admin", state: "approved" },
    });
  });

  it("rolls back allowlist persistence and audits rollback when approval audit fails", () => {
    const allowlistPath = join(mkdtempSync(join(tmpdir(), "allowlist-")), "allowlist.json");
    const auditEvents: Parameters<ApprovalAuditWriter["write"]>[0][] = [];
    const audit: ApprovalAuditWriter = {
      write(event) {
        if (event.eventType === "approval.approved") throw new Error("approval audit unavailable");
        auditEvents.push(event);
      },
    };
    const store = new ApprovalStore({
      defaultTimeoutSeconds: 300,
      audit,
      allowlistOnboarding: {
        store: new JsonFileAllowlistOnboardingStore(allowlistPath),
        audit,
      },
    });
    const req = store.create({ ...baseParams, approvalType: "allowlist_onboarding" });

    expect(() => store.approve(req.approvalId, "admin")).toThrow("approval audit unavailable");

    expect(JSON.parse(readFileSync(allowlistPath, "utf8"))).toEqual([]);
    expect(store.get(req.approvalId)?.state).toBe("pending");
    expect(auditEvents.map((event) => event.eventType)).toEqual([
      "allowlist.updated",
      "allowlist.updated",
    ]);
    expect(auditEvents[1].data).toMatchObject({ rolledBack: true });
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
