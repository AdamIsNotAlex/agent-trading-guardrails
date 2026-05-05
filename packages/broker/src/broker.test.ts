import type { AuditEventType, TradingIntent } from "@guardrails/schemas";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { describe, expect, it, vi } from "vitest";
import { type BrokerConfig, ExecutionBroker, type GuardrailApproval } from "./broker.js";
import { InMemoryBrokerIdempotencyStore } from "./idempotency-store.js";
import type { AuditWriter, BrokerIdempotencyStore, ExecutionConnector } from "./interfaces.js";
import { InMemoryKillSwitch } from "./kill-switch.js";
import { PaperExecutionConnector } from "./paper-connector.js";

const config: BrokerConfig = {
  environment: "paper",
  canaryLiveEnabled: false,
};

function makeApproval(intent: TradingIntent = binanceSpotOrder): GuardrailApproval {
  return {
    intentId: intent.intentId,
    correlationId: "corr-001",
    outcome: "allow",
    intent,
  };
}

function makeAudit(): AuditWriter & {
  events: Array<{ eventType: AuditEventType; data?: unknown }>;
} {
  const events: Array<{ eventType: AuditEventType; data?: unknown }> = [];
  return {
    events,
    write(event) {
      events.push(event as { eventType: AuditEventType; data?: unknown });
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
    expect(result.orderId).toBeTruthy();
    expect(result.revalidationPassed).toBe(true);
    expect(audit.events.some((e) => e.eventType === "broker.executed")).toBe(true);
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

  it("rejects when canary_live is not enabled", async () => {
    const canaryConfig: BrokerConfig = { environment: "canary_live", canaryLiveEnabled: false };
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
    const canaryConfig: BrokerConfig = { environment: "canary_live", canaryLiveEnabled: true };
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
    const prodConfig: BrokerConfig = { environment: "production", canaryLiveEnabled: false };
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

  it("allows same idempotency key with different payload after TTL expires", async () => {
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

    expect(result.status).toBe("executed");
  });

  it("re-executes after idempotency entry TTL expires", async () => {
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
    expect(execute).toHaveBeenCalledTimes(2);
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
    ).toThrow("cannot be used");
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
