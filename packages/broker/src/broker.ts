import { createHmac, timingSafeEqual } from "node:crypto";
import { type ApprovalRequest, ApprovalStore } from "@guardrails/approval";
import { type BrokerExecutionResult, type Environment, TradingIntent } from "@guardrails/schemas";
import { assertNotVaultDevInProduction, redactSecrets } from "@guardrails/secrets";
import {
  type AuditWriter,
  type BrokerIdempotencyReservation,
  type BrokerIdempotencyStore,
  ConnectorRevalidationError,
  type ExecutionConnector,
  IdempotencyConflictError,
  type KillSwitch,
  type KillSwitchScope,
} from "./interfaces.js";

export interface BrokerConfig {
  environment: Environment;
  canaryLiveEnabled: boolean;
  decisionVerificationSecret: string;
  decisionMaxAgeMs?: number;
  vaultAddr?: string;
}

export type GuardrailApproval =
  | {
      intentId: string;
      correlationId: string;
      outcome: "allow";
      intent: TradingIntent;
      decidedAt: string;
      decisionToken: string;
      approvalId?: string;
    }
  | {
      intentId: string;
      correlationId: string;
      outcome: "needs_human";
      intent: TradingIntent;
      decidedAt: string;
      decisionToken: string;
      approvalId: string;
    };

export function createGuardrailDecisionToken(params: {
  secret: string;
  intent: TradingIntent;
  outcome: "allow" | "needs_human";
  correlationId: string;
  decidedAt: string;
  approvalId?: string;
}): string {
  return createHmac("sha256", params.secret)
    .update(
      stableJson({
        intent: params.intent,
        outcome: params.outcome,
        correlationId: params.correlationId,
        decidedAt: params.decidedAt,
        approvalId: params.approvalId ?? null,
      }),
    )
    .digest("hex");
}

export class ExecutionBroker {
  constructor(
    private config: BrokerConfig,
    private connector: ExecutionConnector,
    private killSwitch: KillSwitch,
    private audit: AuditWriter,
    private idempotency: BrokerIdempotencyStore,
    private approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 }),
  ) {
    assertDecisionSecret(config.environment, config.decisionVerificationSecret);
    if (
      config.decisionMaxAgeMs !== undefined &&
      (!Number.isFinite(config.decisionMaxAgeMs) || config.decisionMaxAgeMs <= 0)
    ) {
      throw new Error("Decision max age must be a positive finite number of milliseconds.");
    }
    if (config.vaultAddr) {
      assertNotVaultDevInProduction(config.environment, config.vaultAddr);
    }
  }

  async execute(approval: GuardrailApproval): Promise<BrokerExecutionResult> {
    const now = new Date().toISOString();
    const parseResult = TradingIntent.safeParse(approval.intent);
    if (!parseResult.success) {
      const fallbackIntent = {
        intentId: approval.intentId,
        idempotencyKey: "invalid-approval-intent",
        principal: "unknown",
      } as TradingIntent;
      return this.reject(
        fallbackIntent,
        now,
        approval.correlationId,
        "schema_validation",
        "Approval intent is malformed.",
      );
    }
    const intent = parseResult.data;

    const outcome = approval.outcome as string;
    if (outcome !== "allow" && outcome !== "needs_human") {
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "broker_rejected",
        "Only approved decisions can be executed.",
      );
    }

    if (!this.decisionTokenMatches(approval, intent)) {
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "decision_token_invalid",
        "Guardrail decision token is invalid.",
      );
    }

    if (this.decisionIsStale(approval.decidedAt, now)) {
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "decision_stale",
        "Guardrail decision is stale.",
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

    if (intent.environment !== this.config.environment) {
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "environment_mismatch",
        "Intent environment does not match broker environment.",
      );
    }

    if (approval.intentId !== intent.intentId) {
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "approval_mismatch",
        "Approved decision does not match the execution intent.",
      );
    }

    const hasApprovalId = "approvalId" in approval;
    const approvalId = hasApprovalId ? approval.approvalId : undefined;
    const matchingApproval = this.findApprovalForIntent(intent);
    if (hasApprovalId && (typeof approvalId !== "string" || approvalId.length === 0)) {
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "approval_missing",
        "Human approval is required before execution.",
      );
    }
    if ((outcome === "needs_human" || matchingApproval) && !approvalId) {
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "approval_missing",
        "Human approval is required before execution.",
      );
    }

    let reservation: BrokerIdempotencyReservation;
    try {
      reservation = this.idempotency.begin(intent.idempotencyKey, intent);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return this.reject(
          intent,
          now,
          approval.correlationId,
          "idempotency_conflict",
          err.message,
        );
      }
      throw err;
    }
    if (reservation.status === "cached") return reservation.result;
    if (reservation.status === "pending") return reservation.result;

    let reservationCompleted = false;
    const finish = (result: BrokerExecutionResult): BrokerExecutionResult => {
      reservation.complete(result);
      reservationCompleted = true;
      return result;
    };

    if (approvalId) {
      const approvedRequest = this.approvalStore.get(approvalId);
      if (approvedRequest?.state === "consumed") {
        return finish(
          this.reject(
            intent,
            now,
            approval.correlationId,
            "approval_consumed",
            "Human approval has already been used.",
          ),
        );
      }
      if (!approvedRequest || approvedRequest.state !== "approved") {
        const result = this.reject(
          intent,
          now,
          approval.correlationId,
          "approval_missing",
          "Human approval is required before execution.",
        );
        reservation.abort(new Error(result.rejectionReason));
        reservationCompleted = true;
        return result;
      }
      if (new Date() > new Date(approvedRequest.timeoutAt)) {
        return finish(
          this.reject(
            intent,
            now,
            approval.correlationId,
            "approval_expired",
            "Human approval has expired.",
          ),
        );
      }
      if (
        approvedRequest.approvalType !== "one_time" ||
        !this.approvalMatchesIntent(approvedRequest, intent)
      ) {
        return finish(
          this.reject(
            intent,
            now,
            approval.correlationId,
            "approval_mismatch",
            "Human approval does not match the execution intent.",
          ),
        );
      }
    }

    try {
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
          return finish(
            this.reject(
              intent,
              now,
              approval.correlationId,
              "killswitch_active",
              "Kill switch is active.",
            ),
          );
        }
      }

      if (this.config.environment === "canary_live" && !this.config.canaryLiveEnabled) {
        return finish(
          this.reject(
            intent,
            now,
            approval.correlationId,
            "canary_live_disabled",
            "Canary-live execution is not enabled.",
          ),
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
        const reason = redactSecrets(revalidation.reason ?? "Broker-side revalidation failed.");
        this.audit.write({
          eventType: "broker.failed",
          environment: this.config.environment,
          intentId: intent.intentId,
          principal: intent.principal,
          correlationId: approval.correlationId,
          data: { reason },
        });
        return finish(
          this.reject(intent, now, approval.correlationId, "revalidation_failed", reason),
        );
      }

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
          return finish(
            this.reject(
              intent,
              now,
              approval.correlationId,
              "killswitch_active",
              "Kill switch is active.",
            ),
          );
        }
      }

      if (approvalId && !this.approvalStore.consumeOneTime(approvalId)) {
        return finish(
          this.reject(
            intent,
            now,
            approval.correlationId,
            "approval_consumed",
            "Human approval has already been used.",
          ),
        );
      }

      let executionResult: Awaited<ReturnType<ExecutionConnector["execute"]>>;
      try {
        executionResult = await this.connector.execute(intent);
      } catch (err) {
        const executionError = String(err);
        const revalidationFailed = err instanceof ConnectorRevalidationError;
        const result: BrokerExecutionResult = {
          intentId: intent.intentId,
          idempotencyKey: intent.idempotencyKey,
          status: "failed",
          revalidationPassed: !revalidationFailed,
          rejectionReason: revalidationFailed
            ? "Connector revalidation failed."
            : "Execution failed.",
          executedAt: now,
        };
        finish(result);
        this.audit.write({
          eventType: "broker.failed",
          environment: this.config.environment,
          intentId: intent.intentId,
          principal: intent.principal,
          correlationId: approval.correlationId,
          data: { error: redactSecrets(executionError) },
        });
        return result;
      }

      const result: BrokerExecutionResult = {
        intentId: intent.intentId,
        idempotencyKey: intent.idempotencyKey,
        status: "executed",
        orderId: executionResult.orderId,
        transactionHash: executionResult.transactionHash,
        orderStatus: executionResult.orderStatus,
        revalidationPassed: true,
        executedAt: now,
      };

      finish(result);

      this.audit.write({
        eventType: "broker.executed",
        environment: this.config.environment,
        intentId: intent.intentId,
        principal: intent.principal,
        correlationId: approval.correlationId,
        data: {
          orderId: executionResult.orderId,
          transactionHash: executionResult.transactionHash,
          orderStatus: executionResult.orderStatus,
        },
      });

      return result;
    } catch (err) {
      if (!reservationCompleted) {
        reservation.abort(err);
      }
      throw err;
    }
  }

  private findApprovalForIntent(intent: TradingIntent): ApprovalRequest | undefined {
    return this.approvalStore.list().find((request) => this.approvalMatchesIntent(request, intent));
  }

  private approvalMatchesIntent(request: ApprovalRequest, intent: TradingIntent): boolean {
    return (
      request.intentId === intent.intentId &&
      request.principal === intent.principal &&
      request.action === intent.action &&
      request.resource === intent.resource &&
      request.environment === intent.environment &&
      this.stableJson(request.intentData) === this.stableJson(intent)
    );
  }

  private stableJson(value: unknown): string {
    return stableJson(value);
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
    return result;
  }

  private decisionIsStale(decidedAt: string, now: string): boolean {
    const maxAgeMs = this.config.decisionMaxAgeMs ?? 48 * 60 * 60 * 1000;
    const decidedAtMs = new Date(decidedAt).getTime();
    const nowMs = new Date(now).getTime();
    return (
      !Number.isFinite(decidedAtMs) ||
      decidedAtMs > nowMs + 60_000 ||
      nowMs - decidedAtMs > maxAgeMs
    );
  }

  private decisionTokenMatches(approval: GuardrailApproval, intent: TradingIntent): boolean {
    if (!/^[0-9a-f]{64}$/i.test(approval.decisionToken)) return false;
    const expected = createGuardrailDecisionToken({
      secret: this.config.decisionVerificationSecret,
      intent,
      outcome: approval.outcome,
      correlationId: approval.correlationId,
      decidedAt: approval.decidedAt,
      approvalId: "approvalId" in approval ? approval.approvalId : undefined,
    });
    return timingSafeEqual(
      Buffer.from(approval.decisionToken, "hex"),
      Buffer.from(expected, "hex"),
    );
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

function assertDecisionSecret(environment: Environment, secret: string): void {
  if (secret.length === 0) {
    throw new Error("Guardrail decision verification secret is required.");
  }
  if (environment !== "dev" && secret === "dev-decision-secret") {
    throw new Error("Default guardrail decision verification secret cannot be used outside dev.");
  }
  if (environment !== "dev" && secret.length < 32) {
    throw new Error(
      "Guardrail decision verification secret must be at least 32 characters outside dev.",
    );
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
