import type { AuditEventType, BrokerExecutionResult, TradingIntent } from "@guardrails/schemas";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { describe, expect, it, vi } from "vitest";
import { type BrokerConfig, ExecutionBroker, type GuardrailApproval } from "./broker.js";
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
  const store = new Map<string, BrokerExecutionResult>();
  return {
    get(key) {
      return store.get(key);
    },
    set(key, result) {
      store.set(key, result);
    },
  };
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

  it("returns cached result for same idempotency key", async () => {
    const idempotency = makeIdempotency();
    const broker = new ExecutionBroker(
      config,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      makeAudit(),
      idempotency,
    );
    const first = await broker.execute(makeApproval());
    const second = await broker.execute(makeApproval());
    expect(second).toEqual(first);
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
