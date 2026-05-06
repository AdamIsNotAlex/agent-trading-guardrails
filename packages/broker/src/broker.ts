import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type ApprovalRequest, ApprovalStore } from "@guardrails/approval";
import {
  BrokerExecutionResult as BrokerExecutionResultSchema,
  type BrokerExecutionKind,
  type BrokerExecutionResult,
  type Environment,
  TradingIntent,
} from "@guardrails/schemas";
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
    if (reservation.status === "cached") {
      this.flushPendingTerminalAudit(reservation);
      return reservation.result;
    }
    if (reservation.status === "pending") return reservation.result;

    let reservationCompleted = false;
    let terminalPersistenceStarted = false;
    const finish = (
      result: BrokerExecutionResult,
      pendingAudit?: Parameters<AuditWriter["write"]>[0],
    ): BrokerExecutionResult => {
      reservation.complete(result, pendingAudit);
      reservationCompleted = true;
      return result;
    };

    try {
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
    } catch (err) {
      if (!reservationCompleted && !terminalPersistenceStarted) {
        reservation.abort(err);
      }
      throw err;
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

      const revalidation = await this.connector.revalidate(intent);
      this.audit.write({
        eventType: "broker.revalidated",
        environment: this.config.environment,
        intentId: intent.intentId,
        principal: intent.principal,
        correlationId: approval.correlationId,
        data: {
          passed: revalidation.passed,
          reason: revalidation.reason ? redactSecrets(revalidation.reason) : undefined,
        },
      });
      if (!revalidation.passed) {
        const reason = this.nonEmptyReason(revalidation.reason, "Broker-side revalidation failed.");
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
        executionResult = await this.connector.execute(intent, () => {
          this.assertKillSwitchInactive(scopes, intent, approval.correlationId);
        });
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
        const auditEvent = {
          eventId: this.terminalAuditEventId(intent, approval.correlationId, "broker.failed"),
          eventType: "broker.failed" as const,
          environment: this.config.environment,
          intentId: intent.intentId,
          principal: intent.principal,
          correlationId: approval.correlationId,
          data: { error: redactSecrets(executionError) },
        };
        terminalPersistenceStarted = true;
        return this.finishExecutionWithAudit(reservation, result, auditEvent, () => {
          reservationCompleted = true;
        });
      }

      let result: BrokerExecutionResult;
      try {
        result = this.executedResult(intent, executionResult, now);
      } catch (err) {
        const reason = "Execution evidence validation failed.";
        const failedResult: BrokerExecutionResult = {
          intentId: intent.intentId,
          idempotencyKey: intent.idempotencyKey,
          status: "failed",
          revalidationPassed: true,
          rejectionReason: reason,
          executedAt: now,
        };
        const auditEvent = {
          eventId: this.terminalAuditEventId(intent, approval.correlationId, "broker.failed"),
          eventType: "broker.failed" as const,
          environment: this.config.environment,
          intentId: intent.intentId,
          principal: intent.principal,
          correlationId: approval.correlationId,
          data: { reason, error: redactSecrets(String(err)) },
        };
        terminalPersistenceStarted = true;
        return this.finishExecutionWithAudit(reservation, failedResult, auditEvent, () => {
          reservationCompleted = true;
        });
      }

      const auditEvent = {
        eventId: this.terminalAuditEventId(intent, approval.correlationId, "broker.executed"),
        eventType: "broker.executed" as const,
        environment: this.config.environment,
        intentId: intent.intentId,
        principal: intent.principal,
        correlationId: approval.correlationId,
        data: {
          orderId: executionResult.orderId,
          transactionHash: executionResult.transactionHash,
          orderStatus: executionResult.orderStatus,
          simulationEvidence: executionResult.simulationEvidence,
        },
      };

      terminalPersistenceStarted = true;
      return this.finishExecutionWithAudit(reservation, result, auditEvent, () => {
        reservationCompleted = true;
      });
    } catch (err) {
      if (!reservationCompleted && !terminalPersistenceStarted) {
        reservation.abort(err);
      }
      throw err;
    }
  }

  private executedResult(
    intent: TradingIntent,
    executionResult: Awaited<ReturnType<ExecutionConnector["execute"]>>,
    now: string,
  ): BrokerExecutionResult {
    return BrokerExecutionResultSchema.parse(
      omitUndefined({
        intentId: intent.intentId,
        idempotencyKey: intent.idempotencyKey,
        status: "executed",
        executionKind: this.executionKindForIntent(intent),
        orderId: executionResult.orderId,
        transactionHash: executionResult.transactionHash,
        orderStatus: executionResult.orderStatus,
        simulationEvidence: executionResult.simulationEvidence,
        revalidationPassed: true,
        executedAt: now,
      }),
    );
  }

  private executionKindForIntent(intent: TradingIntent): BrokerExecutionKind {
    switch (intent.action) {
      case "cex.place_order":
        return "cex_order";
      case "cex.cancel_order":
        return "cex_cancel";
      case "cex.get_order_status":
        return "cex_order_status";
      case "onchain.request_signature":
        return "onchain_signature";
      case "onchain.simulate_transaction":
        return "onchain_simulation";
    }
  }

  private finishExecutionWithAudit(
    reservation: Extract<BrokerIdempotencyReservation, { status: "reserved" }>,
    result: BrokerExecutionResult,
    auditEvent: Parameters<AuditWriter["write"]>[0],
    markCompleted: () => void,
  ): BrokerExecutionResult {
    let completionError: unknown;
    try {
      reservation.complete(result, auditEvent);
    } catch (err) {
      completionError = err;
    }
    markCompleted();
    try {
      this.audit.write(auditEvent);
    } catch (err) {
      reservation.failAudit(err);
      throw err;
    }
    if (completionError) throw completionError;
    reservation.completeAudit();
    return result;
  }

  private flushPendingTerminalAudit(
    reservation: Extract<BrokerIdempotencyReservation, { status: "cached" }>,
  ): void {
    if (!reservation.pendingAudit) return;
    this.audit.write(reservation.pendingAudit);
    reservation.completeAudit();
  }

  private terminalAuditEventId(
    intent: TradingIntent,
    correlationId: string,
    eventType: "broker.executed" | "broker.failed",
  ): string {
    const hash = createHash("sha256")
      .update(
        `${eventType}:${intent.intentId}:${intent.idempotencyKey}:${intent.principal}:${intent.action}:${intent.resource}:${correlationId}`,
      )
      .digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
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

  private nonEmptyReason(value: string | undefined, fallback: string): string {
    const reason = value?.trim();
    return redactSecrets(reason && reason.length > 0 ? reason : fallback);
  }

  private reject(
    intent: TradingIntent,
    now: string,
    correlationId: string,
    rule: string,
    message: string,
  ): BrokerExecutionResult {
    const rejectionReason = this.nonEmptyReason(message, "Broker rejected execution.");
    const result: BrokerExecutionResult = {
      intentId: intent.intentId,
      idempotencyKey: intent.idempotencyKey,
      status: "rejected",
      revalidationPassed: false,
      rejectionReason,
      executedAt: now,
    };
    this.audit.write({
      eventType: "broker.failed",
      environment: this.config.environment,
      intentId: intent.intentId,
      principal: intent.principal,
      correlationId,
      data: { rule, message: rejectionReason },
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

  private assertKillSwitchInactive(
    scopes: KillSwitchScope[],
    intent: TradingIntent,
    correlationId: string,
  ): void {
    for (const scope of scopes) {
      if (this.killSwitch.isActive(scope)) {
        this.audit.write({
          eventType: "killswitch.blocked",
          environment: this.config.environment,
          intentId: intent.intentId,
          principal: intent.principal,
          correlationId,
          data: { scope },
        });
        throw new ConnectorRevalidationError("Kill switch is active.");
      }
    }
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

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
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
