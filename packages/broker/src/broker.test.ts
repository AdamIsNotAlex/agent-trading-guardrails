import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore } from "@guardrails/approval";
import { BrokerExecutionResult, type TradingIntent } from "@guardrails/schemas";
import {
  binanceOrderStatus,
  binanceSpotOrder,
  ethereumSepoliaSigning,
  solanaDevnetSimulation,
} from "@guardrails/schemas/fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  type BrokerConfig,
  createGuardrailDecisionToken,
  ExecutionBroker,
  type GuardrailApproval,
} from "./broker.js";
import { FileBrokerIdempotencyStore, InMemoryBrokerIdempotencyStore } from "./idempotency-store.js";
import type { AuditWriter, BrokerIdempotencyStore, ExecutionConnector } from "./interfaces.js";
import { InMemoryKillSwitch, KillSwitchAuditError } from "./kill-switch.js";
import { PaperExecutionConnector } from "./paper-connector.js";

const config: BrokerConfig = {
  environment: "canary_live",
  canaryLiveEnabled: true,
  decisionVerificationSecret: "test-decision-secret-with-32-bytes",
};

function makeApproval(intent: TradingIntent = binanceSpotOrder): GuardrailApproval {
  const correlationId = "corr-001";
  const decidedAt = new Date().toISOString();
  return {
    intentId: intent.intentId,
    correlationId,
    outcome: "allow",
    intent,
    decidedAt,
    decisionToken: createGuardrailDecisionToken({
      secret: config.decisionVerificationSecret,
      intent,
      outcome: "allow",
      correlationId,
      decidedAt,
    }),
  };
}

function makeAllowApprovalWithApprovalId(
  approvalId: string,
  intent: TradingIntent = binanceSpotOrder,
): GuardrailApproval {
  const correlationId = "corr-001";
  const decidedAt = new Date().toISOString();
  return {
    intentId: intent.intentId,
    correlationId,
    outcome: "allow",
    intent,
    decidedAt,
    approvalId,
    decisionToken: createGuardrailDecisionToken({
      secret: config.decisionVerificationSecret,
      intent,
      outcome: "allow",
      correlationId,
      decidedAt,
      approvalId,
    }),
  };
}

function makeNeedsHumanApproval(
  approvalId: string,
  intent: TradingIntent = binanceSpotOrder,
): GuardrailApproval {
  const correlationId = "corr-001";
  const decidedAt = new Date().toISOString();
  return {
    intentId: intent.intentId,
    correlationId,
    outcome: "needs_human",
    intent,
    decidedAt,
    approvalId,
    decisionToken: createGuardrailDecisionToken({
      secret: config.decisionVerificationSecret,
      intent,
      outcome: "needs_human",
      correlationId,
      decidedAt,
      approvalId,
    }),
  };
}

function createApprovalRequest(
  store: ApprovalStore,
  approvalType: "one_time" | "allowlist_onboarding" = "one_time",
) {
  return store.create({
    intentId: binanceSpotOrder.intentId,
    correlationId: "corr-001",
    principal: binanceSpotOrder.principal,
    action: binanceSpotOrder.action,
    resource: binanceSpotOrder.resource,
    environment: binanceSpotOrder.environment,
    escalationReason: "Needs human review.",
    approvalType,
    intentData: binanceSpotOrder as Record<string, unknown>,
  });
}

function makeAudit(): AuditWriter & {
  events: Array<Parameters<AuditWriter["write"]>[0]>;
} {
  const events: Array<Parameters<AuditWriter["write"]>[0]> = [];
  return {
    events,
    write(event) {
      events.push(event);
    },
  };
}

function makeIdempotency(): BrokerIdempotencyStore {
  return new InMemoryBrokerIdempotencyStore();
}

function makeDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("ExecutionBroker", () => {
  it("executes approved intent in paper mode", async () => {
    const audit = makeAudit();
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      audit,
      makeIdempotency(),
    );
    const result = await broker.execute(makeApproval());
    expect(result.status).toBe("executed");
    expect(result.executionKind).toBe("cex_order");
    expect(result.orderId).toBeTruthy();
    expect(result.revalidationPassed).toBe(true);
    expect(() => BrokerExecutionResult.parse(result)).not.toThrow();
    expect(audit.events.some((e) => e.eventType === "broker.executed")).toBe(true);
  });

  it("rejects unsupported paper connector actions", async () => {
    const connector = new PaperExecutionConnector();

    await expect(connector.revalidate(binanceOrderStatus)).resolves.toMatchObject({
      passed: false,
    });
    await expect(connector.execute(binanceOrderStatus)).rejects.toThrow(
      "does not execute cex.get_order_status",
    );
  });

  it("retries pending execution audit without retrying execution", async () => {
    const execute = vi.fn().mockResolvedValue({ orderId: "order-1" });
    let auditFailures = 1;
    const audit = makeAudit();
    const connector: ExecutionConnector = {
      execute,
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      {
        write(event) {
          if (event.eventType === "broker.executed" && auditFailures > 0) {
            auditFailures -= 1;
            throw new Error("audit unavailable");
          }
          audit.write(event);
        },
      },
      makeIdempotency(),
    );
    const approval = makeApproval();

    await expect(broker.execute(approval)).rejects.toThrow("audit unavailable");
    const result = await broker.execute(approval);

    expect(result).toMatchObject({ status: "executed", orderId: "order-1" });
    expect(audit.events.some((event) => event.eventType === "broker.executed")).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns and audits connector order status", async () => {
    const orderStatus = {
      orderId: binanceOrderStatus.orderId,
      symbol: binanceOrderStatus.symbol,
      side: "BUY",
      status: "FILLED",
      executedQty: 0.002,
      avgPrice: 3500,
    };
    const connector: ExecutionConnector = {
      async execute() {
        return { orderId: orderStatus.orderId, orderStatus };
      },
      async revalidate() {
        return { passed: true };
      },
    };
    const audit = makeAudit();
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      audit,
      makeIdempotency(),
    );

    const result = await broker.execute(makeApproval(binanceOrderStatus));
    const execution = audit.events.find((event) => event.eventType === "broker.executed");

    expect(result.executionKind).toBe("cex_order_status");
    expect(result.orderStatus).toEqual(orderStatus);
    expect(() => BrokerExecutionResult.parse(result)).not.toThrow();
    expect(execution?.data).toMatchObject({ orderStatus });
  });

  it("stores terminal failure when connector returns no execution evidence", async () => {
    const execute = vi.fn(async () => ({}) as never);
    const audit = makeAudit();
    const connector: ExecutionConnector = {
      execute,
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      audit,
      makeIdempotency(),
    );
    const approval = makeApproval();

    const result = await broker.execute(approval);
    const cached = await broker.execute(approval);

    expect(result).toMatchObject({
      status: "failed",
      rejectionReason: "Execution evidence validation failed.",
    });
    expect(cached).toEqual(result);
    expect(execute).toHaveBeenCalledOnce();
    expect(audit.events.some((event) => event.eventType === "broker.failed")).toBe(true);
  });

  it("rejects escalated execution when approval is missing", async () => {
    const approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const request = createApprovalRequest(approvalStore);
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );

    const result = await broker.execute(makeNeedsHumanApproval(request.approvalId));

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval is required before execution.");
  });

  it("rejects allow-labeled execution when matching approved approval id is omitted", async () => {
    const approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const request = createApprovalRequest(approvalStore);
    approvalStore.approve(request.approvalId, "operator");
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );

    const result = await broker.execute(makeApproval());

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval is required before execution.");
  });

  it("rejects allow-labeled execution when matching allowlist approval id is omitted", async () => {
    const audit = makeAudit();
    const approvalStore = new ApprovalStore({
      defaultTimeoutSeconds: 300,
      allowlistOnboarding: {
        store: { add: () => () => {} },
        audit,
      },
    });
    const request = createApprovalRequest(approvalStore, "allowlist_onboarding");
    approvalStore.approve(request.approvalId, "operator");
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );

    const result = await broker.execute(makeApproval());

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval is required before execution.");
  });

  it("rejects allow-labeled execution when supplied approval id is empty", async () => {
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );

    const result = await broker.execute(makeAllowApprovalWithApprovalId(""));

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval is required before execution.");
  });

  it("rejects allow-labeled execution when supplied approval is still pending", async () => {
    const approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const request = createApprovalRequest(approvalStore);
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );

    const result = await broker.execute(makeAllowApprovalWithApprovalId(request.approvalId));

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval is required before execution.");
  });

  it("rejects execution when approval id has no matching request", async () => {
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );

    const result = await broker.execute(makeAllowApprovalWithApprovalId("approval-1"));

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval is required before execution.");
  });

  it("rejects allow-labeled execution when supplied approval intent differs", async () => {
    const approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const request = createApprovalRequest(approvalStore);
    approvalStore.approve(request.approvalId, "operator");
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );
    const changedIntent = {
      ...binanceSpotOrder,
      maxNotionalUsd: binanceSpotOrder.maxNotionalUsd + 1,
    };

    const result = await broker.execute(
      makeAllowApprovalWithApprovalId(request.approvalId, changedIntent),
    );

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval does not match the execution intent.");
  });

  it("rejects allowlist onboarding approval for direct execution", async () => {
    const audit = makeAudit();
    const approvalStore = new ApprovalStore({
      defaultTimeoutSeconds: 300,
      allowlistOnboarding: {
        store: { add: () => () => {} },
        audit,
      },
    });
    const request = createApprovalRequest(approvalStore, "allowlist_onboarding");
    approvalStore.approve(request.approvalId, "operator");
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );

    const result = await broker.execute(makeNeedsHumanApproval(request.approvalId));

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval does not match the execution intent.");
  });

  it("rejects allow-labeled execution when a matching approval is still pending", async () => {
    const approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    createApprovalRequest(approvalStore);
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );

    const result = await broker.execute(makeApproval());

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval is required before execution.");
  });

  it("rejects escalated execution when approval belongs to a different intent", async () => {
    const approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const request = createApprovalRequest(approvalStore);
    approvalStore.approve(request.approvalId, "operator");
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );
    const mismatchedIntent = { ...binanceSpotOrder, resource: "cex:binance:sub:BTC-USDC" };

    const result = await broker.execute(
      makeNeedsHumanApproval(request.approvalId, mismatchedIntent),
    );

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval does not match the execution intent.");
  });

  it("rejects escalated execution when approved intent data differs", async () => {
    const approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const request = createApprovalRequest(approvalStore);
    approvalStore.approve(request.approvalId, "operator");
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );
    const changedIntent = {
      ...binanceSpotOrder,
      maxNotionalUsd: binanceSpotOrder.maxNotionalUsd + 1,
    };

    const result = await broker.execute(makeNeedsHumanApproval(request.approvalId, changedIntent));

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval does not match the execution intent.");
  });

  it("executes escalated intent after human approval", async () => {
    const approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const request = createApprovalRequest(approvalStore);
    approvalStore.approve(request.approvalId, "operator");
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );

    const result = await broker.execute(makeNeedsHumanApproval(request.approvalId));

    expect(result.status).toBe("executed");
  });

  it("rejects needs-human execution without an approval id at runtime", async () => {
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );

    const decidedAt = new Date().toISOString();
    const result = await broker.execute({
      intentId: binanceSpotOrder.intentId,
      correlationId: "corr-001",
      outcome: "needs_human",
      intent: binanceSpotOrder,
      decidedAt,
      decisionToken: createGuardrailDecisionToken({
        secret: config.decisionVerificationSecret,
        intent: binanceSpotOrder,
        outcome: "needs_human",
        correlationId: "corr-001",
        decidedAt,
      }),
    } as never);

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Human approval is required before execution.");
  });

  it("rejects invalid decision outcomes at runtime", async () => {
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );

    const result = await broker.execute({ ...makeApproval(), outcome: "deny" } as never);

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Only approved decisions can be executed.");
  });

  it("rejects reuse of a consumed one-time approval", async () => {
    const approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const request = createApprovalRequest(approvalStore);
    approvalStore.approve(request.approvalId, "operator");
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );

    const first = await broker.execute(makeNeedsHumanApproval(request.approvalId));
    const secondIntent = {
      ...binanceSpotOrder,
      intentId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "broker-consumed-approval-reuse",
    };
    const second = await broker.execute(makeNeedsHumanApproval(request.approvalId, secondIntent));

    expect(first.status).toBe("executed");
    expect(second.status).toBe("rejected");
    expect(second.rejectionReason).toBe("Human approval has already been used.");
  });

  it("does not consume one-time approval when broker precheck rejects", async () => {
    const approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const request = createApprovalRequest(approvalStore);
    approvalStore.approve(request.approvalId, "operator");
    const ks = new InMemoryKillSwitch();
    ks.activate({ type: "global" });
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      ks,
      makeAudit(),
      makeIdempotency(),
      approvalStore,
    );

    const result = await broker.execute(makeNeedsHumanApproval(request.approvalId));

    expect(result.status).toBe("rejected");
    expect(approvalStore.get(request.approvalId)?.state).toBe("approved");
  });

  it("requires environment when kill switch activation audit is enabled", () => {
    expect(() => new InMemoryKillSwitch(makeAudit())).toThrow(
      "Kill switch audit requires an environment.",
    );
  });

  it("emits audit event when kill switch is activated", () => {
    const audit = makeAudit();
    const ks = new InMemoryKillSwitch(audit, config.environment);

    ks.activate({ type: "account", account: binanceSpotOrder.account });

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      eventType: "killswitch.activated",
      environment: config.environment,
      data: { scope: { type: "account", account: binanceSpotOrder.account } },
    });
    expect(audit.events[0].correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(audit.events[0]).not.toHaveProperty("principal");
  });

  it("includes principal for agent kill switch activation audit events", () => {
    const audit = makeAudit();
    const ks = new InMemoryKillSwitch(audit, config.environment);

    ks.activate({ type: "agent", principal: binanceSpotOrder.principal });

    expect(audit.events[0]).toMatchObject({
      eventType: "killswitch.activated",
      principal: binanceSpotOrder.principal,
      data: { scope: { type: "agent", principal: binanceSpotOrder.principal } },
    });
  });

  it("surfaces audit failures while keeping kill switch active", () => {
    const cause = new Error("audit down");
    const ks = new InMemoryKillSwitch(
      {
        write() {
          throw cause;
        },
      },
      config.environment,
    );
    const scope = { type: "global" } as const;

    let thrown: unknown;
    try {
      ks.activate(scope);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(KillSwitchAuditError);
    expect(thrown).toMatchObject({
      message: "Kill switch activated, but activation audit failed.",
      cause,
    });
    expect(ks.isActive(scope)).toBe(true);
  });

  it("rejects when kill switch is active (global)", async () => {
    const ks = new InMemoryKillSwitch();
    ks.activate({ type: "global" });
    const audit = makeAudit();
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      ks,
      audit,
      makeIdempotency(),
    );
    const result = await broker.execute(makeApproval());
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("Kill switch");
    expect(audit.events.some((e) => e.eventType === "killswitch.blocked")).toBe(true);
  });

  it("rejects when kill switch is active (per-agent)", async () => {
    const ks = new InMemoryKillSwitch();
    ks.activate({ type: "agent", principal: binanceSpotOrder.principal });
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      ks,
      makeAudit(),
      makeIdempotency(),
    );
    const result = await broker.execute(makeApproval());
    expect(result.status).toBe("rejected");
  });

  it("rejects when kill switch is active (per-exchange)", async () => {
    const ks = new InMemoryKillSwitch();
    ks.activate({ type: "exchange", exchange: "binance" });
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      ks,
      makeAudit(),
      makeIdempotency(),
    );
    const result = await broker.execute(makeApproval());
    expect(result.status).toBe("rejected");
  });

  it("rejects when kill switch is active (per-account)", async () => {
    const ks = new InMemoryKillSwitch();
    ks.activate({ type: "account", account: binanceSpotOrder.account });
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      ks,
      makeAudit(),
      makeIdempotency(),
    );

    const result = await broker.execute(makeApproval());

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("Kill switch");
  });

  it("does not reject a different account when per-account kill switch is active", async () => {
    const ks = new InMemoryKillSwitch();
    ks.activate({ type: "account", account: binanceSpotOrder.account });
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      ks,
      makeAudit(),
      makeIdempotency(),
    );
    const otherAccountIntent: TradingIntent = {
      ...binanceSpotOrder,
      intentId: "550e8400-e29b-41d4-a716-446655440009",
      account: "subaccount-2",
      resource: "cex:binance:subaccount-2:ETH-USDC",
      idempotencyKey: "spot-order-other-account",
    };

    const result = await broker.execute(makeApproval(otherAccountIntent));

    expect(result.status).toBe("executed");
  });

  it("rejects when kill switch is active (per-chain)", async () => {
    const ks = new InMemoryKillSwitch();
    ks.activate({ type: "chain", chain: solanaDevnetSimulation.chain });
    const broker = new ExecutionBroker(
      { ...config, environment: "testnet" },
      new PaperExecutionConnector(),
      ks,
      makeAudit(),
      makeIdempotency(),
    );

    const result = await broker.execute(makeApproval(solanaDevnetSimulation));

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("Kill switch");
  });

  it("does not reject a different chain when per-chain kill switch is active", async () => {
    const ks = new InMemoryKillSwitch();
    ks.activate({ type: "chain", chain: solanaDevnetSimulation.chain });
    const broker = new ExecutionBroker(
      { ...config, environment: "testnet" },
      new PaperExecutionConnector(),
      ks,
      makeAudit(),
      makeIdempotency(),
    );
    const ethereumIntent: TradingIntent = {
      ...ethereumSepoliaSigning,
      intentId: "550e8400-e29b-41d4-a716-446655440010",
      idempotencyKey: "sign-eth-other-chain",
    };

    const result = await broker.execute(makeApproval(ethereumIntent));

    expect(result.status).toBe("executed");
  });

  it("blocks side effects when kill switch activates inside connector execution", async () => {
    let sideEffects = 0;
    const killSwitch = new InMemoryKillSwitch();
    const connector: ExecutionConnector = {
      async execute(_intent, beforeSideEffect) {
        killSwitch.activate({ type: "global" });
        beforeSideEffect?.();
        sideEffects += 1;
        return { orderId: "order-1" };
      },
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      killSwitch,
      makeAudit(),
      makeIdempotency(),
    );

    const result = await broker.execute(makeApproval());

    expect(result).toMatchObject({ status: "failed", revalidationPassed: false });
    expect(sideEffects).toBe(0);
  });

  it("rejects when canary_live is not enabled", async () => {
    const canaryConfig: BrokerConfig = {
      environment: "canary_live",
      canaryLiveEnabled: false,
      decisionVerificationSecret: config.decisionVerificationSecret,
    };
    const broker = new ExecutionBroker(
      canaryConfig,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );
    const result = await broker.execute(makeApproval());
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("not enabled");
  });

  it("allows canary_live when explicitly enabled", async () => {
    const canaryConfig: BrokerConfig = {
      environment: "canary_live",
      canaryLiveEnabled: true,
      decisionVerificationSecret: config.decisionVerificationSecret,
    };
    const broker = new ExecutionBroker(
      canaryConfig,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );
    const result = await broker.execute(makeApproval());
    expect(result.status).toBe("executed");
  });

  it("rejects production execution", async () => {
    const prodConfig: BrokerConfig = {
      environment: "production",
      canaryLiveEnabled: false,
      decisionVerificationSecret: config.decisionVerificationSecret,
    };
    const broker = new ExecutionBroker(
      prodConfig,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );
    const result = await broker.execute(makeApproval());
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("not yet supported");
  });

  it("rejects when revalidation fails", async () => {
    const connector: ExecutionConnector = {
      async execute() {
        return { orderId: "test" };
      },
      async revalidate() {
        return { passed: false, reason: "Stale market data." };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );
    const result = await broker.execute(makeApproval());
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("Stale market data");
  });

  it("uses fallback reason when revalidation failure reason is blank", async () => {
    const connector: ExecutionConnector = {
      async execute() {
        return { orderId: "test" };
      },
      async revalidate() {
        return { passed: false, reason: "" };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );

    const result = await broker.execute(makeApproval());

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Broker-side revalidation failed.");
    expect(() => BrokerExecutionResult.parse(result)).not.toThrow();
  });

  it("redacts secrets from revalidation failure reasons", async () => {
    const privateKey = `0x${"a".repeat(64)}`;
    const connector: ExecutionConnector = {
      async execute() {
        return { orderId: "test" };
      },
      async revalidate() {
        return { passed: false, reason: `Stale market data privateKey=${privateKey}` };
      },
    };
    const audit = makeAudit();
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      audit,
      makeIdempotency(),
    );

    const result = await broker.execute(makeApproval());
    const failure = audit.events.find((event) => event.eventType === "broker.failed");

    expect(result.rejectionReason).toContain("[REDACTED]");
    expect(result.rejectionReason).not.toContain(privateKey);
    expect(JSON.stringify(failure?.data)).toContain("[REDACTED]");
    expect(JSON.stringify(failure?.data)).not.toContain(privateKey);
  });

  it("returns cached result for same idempotency key and payload", async () => {
    const idempotency = makeIdempotency();
    const execute = vi.fn().mockResolvedValue({ orderId: "order-1" });
    const connector: ExecutionConnector = {
      execute,
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      makeAudit(),
      idempotency,
    );

    const first = await broker.execute(makeApproval());
    const second = await broker.execute(makeApproval());

    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("shares pending execution for concurrent requests with the same payload", async () => {
    const execution = makeDeferred<{ orderId: string }>();
    const execute = vi.fn().mockReturnValue(execution.promise);
    const connector: ExecutionConnector = {
      execute,
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );

    const first = broker.execute(makeApproval());
    const second = broker.execute(makeApproval());

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    execution.resolve({ orderId: "order-1" });

    await expect(second).resolves.toEqual(await first);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects concurrent reused idempotency key with different payload before execution", async () => {
    const execution = makeDeferred<{ orderId: string }>();
    const execute = vi.fn().mockReturnValue(execution.promise);
    const connector: ExecutionConnector = {
      execute,
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );
    const changedIntent = {
      ...binanceSpotOrder,
      maxNotionalUsd: binanceSpotOrder.maxNotionalUsd + 1,
    };

    const first = broker.execute(makeApproval());
    const conflict = await broker.execute(makeApproval(changedIntent));
    execution.resolve({ orderId: "order-1" });

    expect(conflict.status).toBe("rejected");
    expect(conflict.rejectionReason).toContain("different intent payload");
    expect(await first).toMatchObject({ status: "executed", orderId: "order-1" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("scopes idempotency keys by principal and resource", async () => {
    const idempotency = makeIdempotency();
    const execute = vi.fn().mockResolvedValue({ orderId: "order-1" });
    const connector: ExecutionConnector = {
      execute,
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      makeAudit(),
      idempotency,
    );
    const otherPrincipalIntent = {
      ...binanceSpotOrder,
      principal: "agent.hermes.strategy-beta",
      maxNotionalUsd: binanceSpotOrder.maxNotionalUsd + 1,
    };
    const otherResourceIntent = {
      ...binanceSpotOrder,
      resource: "cex:binance:subaccount-2:ETH-USDC",
      maxNotionalUsd: binanceSpotOrder.maxNotionalUsd + 2,
    };

    await broker.execute(makeApproval());
    const principalResult = await broker.execute(makeApproval(otherPrincipalIntent));
    const resourceResult = await broker.execute(makeApproval(otherResourceIntent));

    expect(principalResult.status).toBe("executed");
    expect(resourceResult.status).toBe("executed");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("rejects reused idempotency key with different payload", async () => {
    const idempotency = makeIdempotency();
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      idempotency,
    );
    const changedIntent = {
      ...binanceSpotOrder,
      maxNotionalUsd: binanceSpotOrder.maxNotionalUsd + 1,
    };

    await broker.execute(makeApproval());
    const result = await broker.execute(makeApproval(changedIntent));

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("different intent payload");
  });

  it("caches execution failure before failure audit errors", async () => {
    let failureAuditWrites = 0;
    const audit: AuditWriter = {
      write(event) {
        if (event.eventType === "broker.failed" && failureAuditWrites++ === 0) {
          throw new Error("audit down");
        }
      },
    };
    const execute = vi.fn().mockRejectedValue(new Error("connector timeout"));
    const connector: ExecutionConnector = {
      execute,
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      audit,
      makeIdempotency(),
    );

    await expect(broker.execute(makeApproval())).rejects.toThrow("audit down");
    const result = await broker.execute(makeApproval());

    expect(result).toMatchObject({ status: "failed", rejectionReason: "Execution failed." });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("caches successful execution before post-execution audit failures", async () => {
    let auditWrites = 0;
    const audit: AuditWriter = {
      write(event) {
        if (event.eventType === "broker.executed" && auditWrites++ === 0) {
          throw new Error("audit down");
        }
      },
    };
    const execute = vi.fn().mockResolvedValue({ orderId: "order-1" });
    const connector: ExecutionConnector = {
      execute,
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      audit,
      makeIdempotency(),
    );

    await expect(broker.execute(makeApproval())).rejects.toThrow("audit down");
    const result = await broker.execute(makeApproval());

    expect(result).toMatchObject({ status: "executed", orderId: "order-1" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("audits terminal execution even when result persistence fails", async () => {
    const audit = makeAudit();
    const execute = vi.fn().mockResolvedValue({ orderId: "order-1" });
    const abort = vi.fn();
    const idempotency: BrokerIdempotencyStore = {
      begin() {
        return {
          status: "reserved",
          complete() {
            throw new Error("idempotency disk down");
          },
          completeAudit() {},
          failAudit() {},
          abort,
        };
      },
    };
    const connector: ExecutionConnector = {
      execute,
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      audit,
      idempotency,
    );

    await expect(broker.execute(makeApproval())).rejects.toThrow("idempotency disk down");

    expect(execute).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(audit.events.some((event) => event.eventType === "broker.executed")).toBe(true);
  });

  it("persists completed idempotency results across store instances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-idempotency-"));
    try {
      const path = join(dir, "store.json");
      const firstStore = new FileBrokerIdempotencyStore(path);
      const firstExecute = vi.fn().mockResolvedValue({ orderId: "order-1" });
      const connector: ExecutionConnector = {
        execute: firstExecute,
        async revalidate() {
          return { passed: true };
        },
      };
      const firstBroker = new ExecutionBroker(
        config,
        connector,
        new InMemoryKillSwitch(),
        makeAudit(),
        firstStore,
      );

      await firstBroker.execute(makeApproval());

      const secondExecute = vi.fn().mockResolvedValue({ orderId: "order-2" });
      const secondBroker = new ExecutionBroker(
        config,
        {
          execute: secondExecute,
          async revalidate() {
            return { passed: true };
          },
        },
        new InMemoryKillSwitch(),
        makeAudit(),
        new FileBrokerIdempotencyStore(path),
      );
      const result = await secondBroker.execute(makeApproval());

      expect(result).toMatchObject({ status: "executed", orderId: "order-1" });
      expect(firstExecute).toHaveBeenCalledOnce();
      expect(secondExecute).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("initializes an empty file idempotency store when the state file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-idempotency-"));
    try {
      const path = join(dir, "store.json");
      const execute = vi.fn().mockResolvedValue({ orderId: "order-1" });
      const broker = new ExecutionBroker(
        config,
        {
          execute,
          async revalidate() {
            return { passed: true };
          },
        },
        new InMemoryKillSwitch(),
        makeAudit(),
        new FileBrokerIdempotencyStore(path),
      );

      const result = await broker.execute(makeApproval());

      expect(result).toMatchObject({ status: "executed", orderId: "order-1" });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects file idempotency state missing entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-idempotency-"));
    try {
      const path = join(dir, "store.json");
      writeFileSync(path, "{}\n");

      expect(() =>
        new FileBrokerIdempotencyStore(path).begin(
          binanceSpotOrder.idempotencyKey,
          binanceSpotOrder,
        ),
      ).toThrow("entries is required");
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects file idempotency state with null entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-idempotency-"));
    try {
      const path = join(dir, "store.json");
      writeFileSync(path, `${JSON.stringify({ entries: null })}\n`);

      expect(() =>
        new FileBrokerIdempotencyStore(path).begin(
          binanceSpotOrder.idempotencyKey,
          binanceSpotOrder,
        ),
      ).toThrow("entries must be an object");
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed file idempotency entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-idempotency-"));
    try {
      const path = join(dir, "store.json");
      writeFileSync(
        path,
        `${JSON.stringify({ entries: { malformed: { status: "cached", payloadHash: "bad" } } })}\n`,
      );

      expect(() =>
        new FileBrokerIdempotencyStore(path).begin(
          binanceSpotOrder.idempotencyKey,
          binanceSpotOrder,
        ),
      ).toThrow("payloadHash is invalid");
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not revalidate or execute when file idempotency state is malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-idempotency-"));
    try {
      const path = join(dir, "store.json");
      writeFileSync(path, `${JSON.stringify({ entries: null })}\n`);
      const revalidate = vi.fn().mockResolvedValue({ passed: true });
      const execute = vi.fn().mockResolvedValue({ orderId: "order-1" });
      const broker = new ExecutionBroker(
        config,
        { execute, revalidate },
        new InMemoryKillSwitch(),
        makeAudit(),
        new FileBrokerIdempotencyStore(path),
      );

      await expect(broker.execute(makeApproval())).rejects.toThrow("entries must be an object");

      expect(revalidate).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects pending waiters when terminal audit fails", async () => {
    const store = new InMemoryBrokerIdempotencyStore();
    const reservation = store.begin(binanceSpotOrder.idempotencyKey, binanceSpotOrder);
    const replay = store.begin(binanceSpotOrder.idempotencyKey, binanceSpotOrder);
    expect(reservation.status).toBe("reserved");
    expect(replay.status).toBe("pending");
    if (reservation.status !== "reserved" || replay.status !== "pending") {
      throw new Error("Unexpected reservation state.");
    }

    reservation.complete(
      {
        intentId: binanceSpotOrder.intentId,
        idempotencyKey: binanceSpotOrder.idempotencyKey,
        status: "executed",
        executionKind: "cex_order",
        orderId: "order-1",
        revalidationPassed: true,
        executedAt: "2026-05-04T12:00:04.000Z",
      },
      {
        eventType: "broker.executed",
        environment: "canary_live",
        intentId: binanceSpotOrder.intentId,
        principal: binanceSpotOrder.principal,
        correlationId: "corr-001",
        data: { orderId: "order-1" },
      },
    );
    reservation.failAudit(new Error("audit down"));

    await expect(replay.result).rejects.toThrow("audit down");
  });

  it("blocks retries for in-progress file idempotency entries after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-idempotency-"));
    try {
      const path = join(dir, "store.json");
      const firstStore = new FileBrokerIdempotencyStore(path, { now: () => 1_000 });
      const reservation = firstStore.begin(binanceSpotOrder.idempotencyKey, binanceSpotOrder);
      expect(reservation.status).toBe("reserved");

      const secondStore = new FileBrokerIdempotencyStore(path, { now: () => 2_000 });
      const replay = secondStore.begin(binanceSpotOrder.idempotencyKey, binanceSpotOrder);

      expect(replay.status).toBe("pending");
      if (replay.status !== "pending") throw new Error("Expected pending replay.");
      await expect(replay.result).rejects.toThrow("already in progress");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears pending idempotency reservation when revalidation throws", async () => {
    const revalidate = vi
      .fn()
      .mockRejectedValueOnce(new Error("risk service down"))
      .mockResolvedValue({ passed: true });
    const execute = vi.fn().mockResolvedValue({ orderId: "order-1" });
    const connector: ExecutionConnector = { execute, revalidate };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );

    await expect(broker.execute(makeApproval())).rejects.toThrow("risk service down");
    const result = await broker.execute(makeApproval());

    expect(result).toMatchObject({ status: "executed", orderId: "order-1" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects invalid idempotency TTLs", () => {
    expect(() => new InMemoryBrokerIdempotencyStore({ ttlMs: 0 })).toThrow("positive finite");
    expect(() => new InMemoryBrokerIdempotencyStore({ ttlMs: Number.NaN })).toThrow(
      "positive finite",
    );
  });

  it("keeps idempotency conflicts after TTL", async () => {
    let now = 1_000;
    const idempotency = new InMemoryBrokerIdempotencyStore({ ttlMs: 100, now: () => now });
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      idempotency,
    );
    const changedIntent = {
      ...binanceSpotOrder,
      maxNotionalUsd: binanceSpotOrder.maxNotionalUsd + 1,
    };

    await broker.execute(makeApproval());
    now = 1_101;
    const result = await broker.execute(makeApproval(changedIntent));

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("Idempotency key");
  });

  it("does not re-execute after idempotency entry TTL", async () => {
    let now = 1_000;
    const idempotency = new InMemoryBrokerIdempotencyStore({ ttlMs: 100, now: () => now });
    const execute = vi.fn().mockResolvedValue({ orderId: "order-1" });
    const connector: ExecutionConnector = {
      execute,
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      makeAudit(),
      idempotency,
    );

    const first = await broker.execute(makeApproval());
    now = 1_101;
    const second = await broker.execute(makeApproval());

    expect(first.status).toBe("executed");
    expect(second.status).toBe("executed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("handles execution failure gracefully", async () => {
    const connector: ExecutionConnector = {
      async execute() {
        throw new Error("CEX API error");
      },
      async revalidate() {
        return { passed: true };
      },
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );
    const result = await broker.execute(makeApproval());
    expect(result.status).toBe("failed");
    expect(result.revalidationPassed).toBe(true);
  });

  it("redacts secrets from execution failure audit events", async () => {
    const privateKey = `0x${"a".repeat(64)}`;
    const connector: ExecutionConnector = {
      async execute() {
        throw new Error(`CEX API error privateKey=${privateKey}`);
      },
      async revalidate() {
        return { passed: true };
      },
    };
    const audit = makeAudit();
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      audit,
      makeIdempotency(),
    );

    await broker.execute(makeApproval());

    const failure = audit.events.find((event) => event.eventType === "broker.failed");
    expect(JSON.stringify(failure?.data)).toContain("[REDACTED]");
    expect(JSON.stringify(failure?.data)).not.toContain(privateKey);
  });

  it("rejects Vault dev server in production broker config", () => {
    const prodConfig: BrokerConfig = {
      environment: "production",
      canaryLiveEnabled: false,
      decisionVerificationSecret: config.decisionVerificationSecret,
      vaultAddr: "http://localhost:8200",
    };

    expect(
      () =>
        new ExecutionBroker(
          prodConfig,
          new PaperExecutionConnector(),
          new InMemoryKillSwitch(),
          makeAudit(),
          makeIdempotency(),
        ),
    ).toThrow("must use HTTPS");
  });

  it("writes audit events for revalidation and execution", async () => {
    const audit = makeAudit();
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      audit,
      makeIdempotency(),
    );
    await broker.execute(makeApproval());
    expect(audit.events.some((e) => e.eventType === "broker.revalidated")).toBe(true);
    expect(audit.events.some((e) => e.eventType === "broker.executed")).toBe(true);
  });

  it("never trusts agent-provided state (uses connector revalidation)", async () => {
    const revalidateSpy = vi.fn().mockResolvedValue({ passed: true });
    const connector: ExecutionConnector = {
      async execute() {
        return { orderId: "test" };
      },
      revalidate: revalidateSpy,
    };
    const broker = new ExecutionBroker(
      config,
      connector,
      new InMemoryKillSwitch(),
      makeAudit(),
      makeIdempotency(),
    );
    await broker.execute(makeApproval());
    expect(revalidateSpy).toHaveBeenCalledWith(binanceSpotOrder);
  });
});
