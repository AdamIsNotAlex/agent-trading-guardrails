import type { BrokerExecutionResult, Environment, TradingIntent } from "@guardrails/schemas";
import type {
  AuditWriter,
  BrokerIdempotencyStore,
  ExecutionConnector,
  KillSwitch,
  KillSwitchScope,
} from "./interfaces.js";

export interface BrokerConfig {
  environment: Environment;
  canaryLiveEnabled: boolean;
}

export interface GuardrailApproval {
  intentId: string;
  correlationId: string;
  outcome: "allow";
  intent: TradingIntent;
}

export class ExecutionBroker {
  constructor(
    private config: BrokerConfig,
    private connector: ExecutionConnector,
    private killSwitch: KillSwitch,
    private audit: AuditWriter,
    private idempotency: BrokerIdempotencyStore,
  ) {}

  async execute(approval: GuardrailApproval): Promise<BrokerExecutionResult> {
    const now = new Date().toISOString();
    const { intent } = approval;

    if (approval.outcome !== "allow") {
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "broker_rejected",
        "Only approved decisions can be executed.",
      );
    }

    const cached = this.idempotency.get(intent.idempotencyKey);
    if (cached) return cached;

    const scopes = this.getKillSwitchScopes(intent);
    for (const scope of scopes) {
      if (this.killSwitch.isActive(scope)) {
        this.audit.write({
          eventType: "killswitch.blocked",
          environment: this.config.environment,
          intentId: intent.intentId,
          principal: intent.principal,
          correlationId: approval.correlationId,
          data: { scope },
        });
        return this.reject(
          intent,
          now,
          approval.correlationId,
          "killswitch_active",
          "Kill switch is active.",
        );
      }
    }

    if (this.config.environment === "canary_live" && !this.config.canaryLiveEnabled) {
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "canary_live_disabled",
        "Canary-live execution is not enabled.",
      );
    }

    if (this.config.environment === "production") {
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "production_not_supported",
        "Production execution is not yet supported.",
      );
    }

    this.audit.write({
      eventType: "broker.revalidated",
      environment: this.config.environment,
      intentId: intent.intentId,
      principal: intent.principal,
      correlationId: approval.correlationId,
      data: { status: "starting" },
    });

    const revalidation = await this.connector.revalidate(intent);
    if (!revalidation.passed) {
      this.audit.write({
        eventType: "broker.failed",
        environment: this.config.environment,
        intentId: intent.intentId,
        principal: intent.principal,
        correlationId: approval.correlationId,
        data: { reason: revalidation.reason },
      });
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "revalidation_failed",
        revalidation.reason ?? "Broker-side revalidation failed.",
      );
    }

    let executionResult: { orderId?: string; transactionHash?: string };
    try {
      executionResult = await this.connector.execute(intent);
    } catch (err) {
      this.audit.write({
        eventType: "broker.failed",
        environment: this.config.environment,
        intentId: intent.intentId,
        principal: intent.principal,
        correlationId: approval.correlationId,
        data: { error: String(err) },
      });
      const result: BrokerExecutionResult = {
        intentId: intent.intentId,
        idempotencyKey: intent.idempotencyKey,
        status: "failed",
        revalidationPassed: true,
        rejectionReason: "Execution failed.",
        executedAt: now,
      };
      this.idempotency.set(intent.idempotencyKey, result);
      return result;
    }

    const result: BrokerExecutionResult = {
      intentId: intent.intentId,
      idempotencyKey: intent.idempotencyKey,
      status: "executed",
      orderId: executionResult.orderId,
      transactionHash: executionResult.transactionHash,
      revalidationPassed: true,
      executedAt: now,
    };

    this.audit.write({
      eventType: "broker.executed",
      environment: this.config.environment,
      intentId: intent.intentId,
      principal: intent.principal,
      correlationId: approval.correlationId,
      data: { orderId: executionResult.orderId, transactionHash: executionResult.transactionHash },
    });

    this.idempotency.set(intent.idempotencyKey, result);
    return result;
  }

  private reject(
    intent: TradingIntent,
    now: string,
    correlationId: string,
    rule: string,
    message: string,
  ): BrokerExecutionResult {
    const result: BrokerExecutionResult = {
      intentId: intent.intentId,
      idempotencyKey: intent.idempotencyKey,
      status: "rejected",
      revalidationPassed: false,
      rejectionReason: message,
      executedAt: now,
    };
    this.audit.write({
      eventType: "broker.failed",
      environment: this.config.environment,
      intentId: intent.intentId,
      principal: intent.principal,
      correlationId,
      data: { rule, message },
    });
    this.idempotency.set(intent.idempotencyKey, result);
    return result;
  }

  private getKillSwitchScopes(intent: TradingIntent): KillSwitchScope[] {
    const scopes: KillSwitchScope[] = [
      { type: "global" },
      { type: "agent", principal: intent.principal },
    ];
    if ("exchange" in intent) {
      scopes.push({ type: "exchange", exchange: intent.exchange });
    }
    if ("account" in intent) {
      scopes.push({ type: "account", account: intent.account });
    }
    if ("chain" in intent) {
      scopes.push({ type: "chain", chain: intent.chain });
    }
    return scopes;
  }
}
