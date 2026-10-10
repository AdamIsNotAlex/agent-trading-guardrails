import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore } from "@guardrails/approval";
import { AuditWriter } from "@guardrails/audit";
import {
  createGuardrailDecisionToken,
  ExecutionBroker,
  FileBrokerIdempotencyStore,
  type GuardrailApproval,
  type GuardrailDryRunApproval,
  InMemoryKillSwitch,
} from "@guardrails/broker";
import type { BrokerOrderReconciliation, TradingIntent } from "@guardrails/schemas";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const secret = "canary-regression-decision-secret-32-characters";
const resources: Array<() => void> = [];
const config = {
  environment: "canary_live" as const,
  canaryLiveEnabled: true,
  decisionVerificationSecret: secret,
};
const acknowledged = {
  orderId: "42",
  symbol: "ETH-USDC",
  side: "BUY",
  status: "NEW",
  executedQty: 0,
  avgPrice: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const close of resources.splice(0).reverse()) close();
});

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "canary-live-"));
  resources.push(() => rmSync(directory, { recursive: true, force: true }));
  const db = new Database(join(directory, "audit.db"));
  resources.push(() => db.close());
  const audit = new AuditWriter(db, {
    environment: "canary_live",
    hashSecret: "canary-regression-audit-secret-32-characters",
    hashAnchorPath: join(directory, "audit.hash"),
  });
  const approvals = new ApprovalStore({
    databasePath: join(directory, "approvals.db"),
    defaultTimeoutSeconds: 300,
    audit,
  });
  resources.push(() => approvals.close());
  const kill = new InMemoryKillSwitch();
  const reconciliation: BrokerOrderReconciliation = {
    status: "matched",
    checkedAt: new Date().toISOString(),
    expected: acknowledged,
    observed: acknowledged,
    discrepancies: [],
  };
  const execute = vi.fn(async (_intent: TradingIntent, before?: () => void) => {
    before?.();
    return { orderId: acknowledged.orderId, orderStatus: acknowledged, reconciliation };
  });
  const revalidate = vi.fn(async (_intent: TradingIntent) => ({ passed: true }));
  const createBroker = () =>
    new ExecutionBroker(
      config,
      { execute, revalidate },
      kill,
      audit,
      new FileBrokerIdempotencyStore(join(directory, "idempotency.json")),
      approvals,
    );
  return {
    broker: createBroker(),
    createBroker,
    execute,
    revalidate,
    audit,
    db,
    approvals,
    kill,
    reconciliation,
  };
}

function preview(
  intent: TradingIntent = binanceSpotOrder,
  outcome: "allow" | "needs_human" = "allow",
): GuardrailDryRunApproval {
  const facts = {
    dryRun: true as const,
    intent,
    outcome,
    correlationId: "preview-correlation",
    decidedAt: new Date().toISOString(),
  };
  return {
    ...facts,
    intentId: intent.intentId,
    decisionToken: createGuardrailDecisionToken({ ...facts, secret }),
  };
}

function approval(
  intent: TradingIntent = binanceSpotOrder,
  approvalId?: string,
): GuardrailApproval {
  const facts = {
    intent,
    correlationId: "execution-correlation",
    decidedAt: new Date().toISOString(),
  };
  if (approvalId) {
    const authorized = { ...facts, outcome: "needs_human" as const, approvalId };
    return {
      ...authorized,
      intentId: intent.intentId,
      decisionToken: createGuardrailDecisionToken({ ...authorized, secret }),
    };
  }
  const authorized = { ...facts, outcome: "allow" as const };
  return {
    ...authorized,
    intentId: intent.intentId,
    decisionToken: createGuardrailDecisionToken({ ...authorized, secret }),
  };
}

function approvedRequest(store: ApprovalStore) {
  const request = store.create({
    intentId: binanceSpotOrder.intentId,
    correlationId: "execution-correlation",
    principal: binanceSpotOrder.principal,
    action: binanceSpotOrder.action,
    resource: binanceSpotOrder.resource,
    environment: binanceSpotOrder.environment,
    escalationReason: "Operator review required.",
    approvalType: "one_time",
    intentData: binanceSpotOrder,
  });
  store.approve(request.approvalId, "operator");
  return request.approvalId;
}

describe("canary first-order closure", () => {
  it("previews without consuming approval or reserving execution, then executes exactly once", async () => {
    const h = harness();
    const id = approvedRequest(h.approvals);
    const before = h.approvals.list();
    const report = await h.broker.dryRun(preview(binanceSpotOrder, "needs_human"));
    expect(report).toMatchObject({ passed: true, requiresHumanApproval: true });
    expect(h.approvals.list()).toEqual(before);
    expect(h.execute).not.toHaveBeenCalled();
    const signed = approval(binanceSpotOrder, id);
    const result = await h.broker.execute(signed, { dryRunAuthorization: report.authorization });
    expect(result).toMatchObject({
      status: "executed",
      orderId: "42",
      reconciliation: { status: "matched" },
    });
    expect(h.approvals.get(id)?.state).toBe("consumed");
    expect(await h.createBroker().execute(signed)).toEqual(result);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("does not issue or spend a receipt after revalidation outlives its freshness window", async () => {
    vi.useFakeTimers();
    const h = harness();
    const delayed = async () => {
      vi.setSystemTime(Date.now() + 300_001);
      return { passed: true };
    };
    h.revalidate.mockImplementation(delayed);
    const stalePreview = await h.broker.dryRun(preview());
    expect(stalePreview.passed).toBe(false);
    expect(stalePreview.authorization).toBeUndefined();
    h.revalidate.mockResolvedValue({ passed: true });
    const fresh = await h.broker.dryRun(preview());
    h.revalidate.mockImplementation(delayed);
    const result = await h.broker.execute(approval(), { dryRunAuthorization: fresh.authorization });
    expect(result.status).toBe("rejected");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "tampered",
    "different-intent",
    "expired",
    "future",
  ] as const)("rejects a %s receipt without poisoning the idempotency key", async (kind) => {
    vi.useFakeTimers();
    const h = harness();
    const startingTime = Date.now();
    if (kind === "future") vi.setSystemTime(startingTime + 1000);
    const source =
      kind === "different-intent" ? { ...binanceSpotOrder, quantity: 0.001 } : binanceSpotOrder;
    const report = await h.broker.dryRun(preview(source));
    expect(report.passed).toBe(true);
    let authorization = report.authorization;
    if (kind === "missing") authorization = undefined;
    if (kind === "tampered" && authorization)
      authorization = { ...authorization, token: "0".repeat(64) };
    if (kind === "expired") vi.setSystemTime(startingTime + 300_001);
    if (kind === "future") vi.setSystemTime(startingTime);
    const signed = approval();
    expect((await h.broker.execute(signed, { dryRunAuthorization: authorization })).status).toBe(
      "rejected",
    );
    expect(h.execute).not.toHaveBeenCalled();
    const fresh = await h.broker.dryRun(preview());
    expect(
      (await h.broker.execute(signed, { dryRunAuthorization: fresh.authorization })).status,
    ).toBe("executed");
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("cannot promote a signed preview by removing its dry-run marker", async () => {
    const h = harness();
    const dry = preview();
    const { dryRun: _marker, ...stripped } = dry;
    expect((await h.broker.execute({ ...stripped, outcome: "allow" })).status).toBe("rejected");
    expect((await h.broker.execute(dry as unknown as GuardrailApproval)).status).toBe("rejected");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("does not consume approval when kill reachability disappears during revalidation", async () => {
    const h = harness();
    const id = approvedRequest(h.approvals);
    const report = await h.broker.dryRun(preview(binanceSpotOrder, "needs_human"));
    h.revalidate.mockImplementation(async () => {
      vi.spyOn(h.kill, "isActive").mockReturnValue(undefined as unknown as boolean);
      return { passed: true };
    });
    await expect(
      h.broker.execute(approval(binanceSpotOrder, id), {
        dryRunAuthorization: report.authorization,
      }),
    ).rejects.toThrow();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.approvals.get(id)?.state).toBe("approved");
  });

  it("fails closed on an unwritable audit database and recovers the same intent after repair", async () => {
    const h = harness();
    const report = await h.broker.dryRun(preview());
    h.db.pragma("query_only = ON");
    const failed = await h.broker.dryRun(preview());
    expect(failed.passed).toBe(false);
    expect(failed.authorization).toBeUndefined();
    await expect(
      h.broker.execute(approval(), { dryRunAuthorization: report.authorization }),
    ).rejects.toThrow();
    expect(h.execute).not.toHaveBeenCalled();
    h.db.pragma("query_only = OFF");
    expect(
      (await h.broker.execute(approval(), { dryRunAuthorization: report.authorization })).status,
    ).toBe("executed");
  });

  it("retains reconciliation and accepted order across a failed terminal audit and disk replay", async () => {
    const h = harness();
    h.reconciliation.status = "unavailable";
    h.reconciliation.observed = undefined;
    h.reconciliation.discrepancies = ["Order status could not be queried."];
    const report = await h.broker.dryRun(preview());
    const write = h.audit.write.bind(h.audit);
    let failTerminal = true;
    vi.spyOn(h.audit, "write").mockImplementation((event) => {
      if (event.eventType === "broker.executed" && failTerminal) {
        failTerminal = false;
        throw new Error("terminal audit unavailable");
      }
      return write(event);
    });
    const signed = approval();
    await expect(
      h.broker.execute(signed, { dryRunAuthorization: report.authorization }),
    ).rejects.toThrow();
    const replay = await h.createBroker().execute(signed);
    expect(replay).toMatchObject({
      status: "executed",
      orderId: "42",
      reconciliation: { status: "unavailable" },
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
    const row = h.db
      .prepare("SELECT data FROM audit_events WHERE event_type = 'broker.executed'")
      .get() as { data: string };
    expect(JSON.parse(row.data).reconciliation.status).toBe("unavailable");
  });
});
