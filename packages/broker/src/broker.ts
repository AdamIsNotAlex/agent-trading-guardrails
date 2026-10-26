import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type ApprovalRequest, ApprovalStore } from "@guardrails/approval";
import {
  type BrokerExecutionKind,
  type BrokerExecutionResult,
  BrokerExecutionResult as BrokerExecutionResultSchema,
  type Environment,
  TradingIntent,
} from "@guardrails/schemas";
import { assertNotVaultDevInProduction, redactSecrets } from "@guardrails/secrets";
import {
  type BrokerDryRunResult,
  createDryRunAuthorization,
  type DryRunAuthorization,
  dryRunAuthorizationMatches,
  dryRunIsFresh,
  type GuardrailDryRunApproval,
} from "./dry-run.js";
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
import {
  getKillSwitchScopes,
  LiveModePreflightCheck,
  readKillSwitchBlocking,
} from "./preflight.js";

export interface BrokerConfig {
  environment: Environment;
  canaryLiveEnabled: boolean;
  decisionVerificationSecret: string;
  decisionMaxAgeMs?: number;
  vaultAddr?: string;
}

export interface BrokerExecuteOptions {
  dryRunAuthorization?: DryRunAuthorization;
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
  dryRun?: true;
}): string {
  return createHmac("sha256", params.secret)
    .update(
      stableJson({
        intent: params.intent,
        outcome: params.outcome,
        correlationId: params.correlationId,
        decidedAt: params.decidedAt,
        approvalId: params.approvalId ?? null,
        ...(params.dryRun ? { dryRun: true } : {}),
      }),
    )
    .digest("hex");
}

export class ExecutionBroker {
  private approvalStore: ApprovalStore;
  private liveApprovalStore?: ApprovalStore;

  constructor(
    private config: BrokerConfig,
    private connector: ExecutionConnector,
    private killSwitch: KillSwitch,
    private audit: AuditWriter,
    private idempotency: BrokerIdempotencyStore,
    approvalStore?: ApprovalStore,
  ) {
    this.liveApprovalStore = approvalStore;
    this.approvalStore = approvalStore ?? new ApprovalStore({ defaultTimeoutSeconds: 300 });
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

  async execute(
    approval: GuardrailApproval,
    options: BrokerExecuteOptions = {},
  ): Promise<BrokerExecutionResult> {
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
    const canaryOrder =
      this.config.environment === "canary_live" && intent.action === "cex.place_order";
    const dryRunCheckedAt = options.dryRunAuthorization?.checkedAt;
    if ("dryRun" in approval) {
      return this.reject(
        intent,
        now,
        approval.correlationId,
        "dry_run_only",
        "A dry-run decision cannot execute.",
      );
    }

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

    if (this.config.environment === "canary_live") {
      if (!this.config.canaryLiveEnabled) {
        return this.reject(
          intent,
          now,
          approval.correlationId,
          "canary_live_disabled",
          "Canary-live execution is not enabled.",
        );
      }
      const preflight = this.preflight(intent, approval.correlationId);
      if (!preflight.passed) {
        return this.reject(
          intent,
          now,
          approval.correlationId,
          "live_preflight_failed",
          "Live-mode preflight failed.",
        );
      }
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
      if (
        canaryOrder &&
        !dryRunAuthorizationMatches(
          options.dryRunAuthorization,
          this.config.decisionVerificationSecret,
          intent,
          now,
          this.config.decisionMaxAgeMs,
        )
      ) {
        const result = this.reject(
          intent,
          now,
          approval.correlationId,
          "dry_run_required",
          "A fresh successful dry-run report is required for this live order.",
        );
        reservation.abort(new Error(result.rejectionReason));
        reservationCompleted = true;
        return result;
      }
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
          !this.approvalMatchesIntent(approvedRequest, intent, approval.correlationId)
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
      const scopes = getKillSwitchScopes(intent);
      for (const scope of scopes) {
        if (readKillSwitchBlocking(this.killSwitch, scope, intent)) {
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
        if (readKillSwitchBlocking(this.killSwitch, scope, intent)) {
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

      if (
        canaryOrder &&
        !dryRunIsFresh(
          dryRunCheckedAt ?? "",
          new Date().toISOString(),
          this.config.decisionMaxAgeMs,
        )
      ) {
        const result = this.reject(
          intent,
          now,
          approval.correlationId,
          "dry_run_expired",
          "Dry-run report expired during broker revalidation.",
        );
        reservation.abort(new Error(result.rejectionReason));
        reservationCompleted = true;
        return result;
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
          this.assertKillSwitchAllowsExecution(scopes, intent, approval.correlationId);
          if (
            canaryOrder &&
            !dryRunIsFresh(
              dryRunCheckedAt ?? "",
              new Date().toISOString(),
              this.config.decisionMaxAgeMs,
            )
          ) {
            throw new ConnectorRevalidationError("Dry-run report expired before submission.");
          }
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
          data: {
            status: result.status,
            rejectionReason: result.rejectionReason,
            error: redactSecrets(executionError),
          },
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
          data: {
            status: failedResult.status,
            rejectionReason: failedResult.rejectionReason,
            reason,
            error: redactSecrets(String(err)),
          },
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
          status: result.status,
          orderId: executionResult.orderId,
          transactionHash: executionResult.transactionHash,
          orderStatus: executionResult.orderStatus,
          reconciliation: executionResult.reconciliation,
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

  async dryRun(approval: GuardrailDryRunApproval): Promise<BrokerDryRunResult> {
    const now = new Date().toISOString();
    const parsed = TradingIntent.safeParse(approval.intent);
    const intent = parsed.success ? parsed.data : undefined;
    const report: BrokerDryRunResult = {
      dryRun: true,
      intentId: approval.intentId,
      correlationId: approval.correlationId,
      checkedAt: now,
      passed: false,
      requiresHumanApproval: approval.outcome === "needs_human",
      checks: [],
    };
    const finish = (): BrokerDryRunResult => {
      report.checkedAt = new Date().toISOString();
      report.passed = report.checks.every((check) => check.passed);
      if (
        report.passed &&
        !dryRunIsFresh(approval.decidedAt, report.checkedAt, this.config.decisionMaxAgeMs)
      ) {
        report.passed = false;
        report.checks.push({
          check: "decision_freshness",
          passed: false,
          message: "Dry-run decision expired during broker revalidation.",
        });
      }
      try {
        this.audit.write({
          eventType: "broker.dry_run",
          environment: this.config.environment,
          intentId: intent?.intentId,
          principal: intent?.principal,
          correlationId: approval.correlationId,
          data: { ...report },
        });
      } catch {
        report.passed = false;
        report.checks.push({
          check: "audit",
          passed: false,
          message: "Dry-run audit could not be written.",
        });
      }
      if (report.passed && intent) {
        report.authorization = createDryRunAuthorization(
          this.config.decisionVerificationSecret,
          intent,
          report.checkedAt,
        );
      }
      return report;
    };
    const validDecision =
      intent !== undefined &&
      approval.dryRun === true &&
      approval.intentId === intent.intentId &&
      (approval.outcome === "allow" || approval.outcome === "needs_human") &&
      dryRunIsFresh(approval.decidedAt, now, this.config.decisionMaxAgeMs) &&
      this.decisionTokenMatches(approval, intent);
    report.checks.push({
      check: "decision",
      passed: validDecision,
      ...(!validDecision ? { message: "A fresh, authentic dry-run decision is required." } : {}),
    });
    if (!validDecision || !intent) return finish();

    const environmentMatches =
      intent.environment === this.config.environment &&
      this.config.environment !== "production" &&
      (this.config.environment !== "canary_live" || this.config.canaryLiveEnabled);
    report.checks.push({
      check: "environment",
      passed: environmentMatches,
      ...(!environmentMatches
        ? { message: "Broker environment is mismatched or execution is disabled." }
        : {}),
    });
    if (!environmentMatches) return finish();

    if (this.config.environment === "canary_live") {
      const preflight = this.preflight(intent, approval.correlationId);
      report.checks.push(...preflight.checks);
      if (!preflight.passed) return finish();
    }
    try {
      const validation = await this.connector.revalidate(intent);
      report.checks.push({
        check: "connector",
        passed: validation.passed === true,
        ...(validation.passed !== true
          ? { message: this.nonEmptyReason(validation.reason, "Connector revalidation failed.") }
          : {}),
      });
      const allowed = getKillSwitchScopes(intent).every(
        (scope) => !readKillSwitchBlocking(this.killSwitch, scope, intent),
      );
      report.checks.push({
        check: "late_kill_switch",
        passed: allowed,
        ...(!allowed ? { message: "Kill switch is active." } : {}),
      });
    } catch {
      report.checks.push({
        check: "broker_revalidation",
        passed: false,
        message: "Broker revalidation or kill-switch reachability failed.",
      });
    }
    return finish();
  }

  private preflight(intent: TradingIntent, correlationId: string) {
    return new LiveModePreflightCheck({
      audit: this.audit,
      killSwitch: this.killSwitch,
      approvalStore: this.liveApprovalStore,
      environment: this.config.environment,
      intent,
      correlationId,
    }).run();
  }

  private executedResult(
    intent: TradingIntent,
    executionResult: Awaited<ReturnType<ExecutionConnector["execute"]>>,
    now: string,
  ): BrokerExecutionResult {
    this.assertExecutionEvidenceMatchesIntent(intent, executionResult);
    return BrokerExecutionResultSchema.parse(
      omitUndefined({
        intentId: intent.intentId,
        idempotencyKey: intent.idempotencyKey,
        status: "executed",
        executionKind: this.executionKindForIntent(intent),
        orderId: executionResult.orderId,
        transactionHash: executionResult.transactionHash,
        orderStatus: executionResult.orderStatus,
        reconciliation: executionResult.reconciliation,
        simulationEvidence: executionResult.simulationEvidence,
        revalidationPassed: true,
        executedAt: now,
      }),
    );
  }

  private assertExecutionEvidenceMatchesIntent(
    intent: TradingIntent,
    executionResult: Awaited<ReturnType<ExecutionConnector["execute"]>>,
  ): void {
    if (intent.action === "cex.cancel_order" && executionResult.orderId !== intent.orderId) {
      throw new Error("Connector execution evidence orderId does not match intent.");
    }
    if (intent.action === "cex.get_order_status") {
      if (executionResult.orderId && executionResult.orderId !== intent.orderId) {
        throw new Error("Connector execution evidence orderId does not match intent.");
      }
      if (!executionResult.orderStatus) {
        throw new Error("Connector order status evidence is missing.");
      }
      if (executionResult.orderStatus.orderId !== intent.orderId) {
        throw new Error("Connector order status orderId does not match intent.");
      }
      if (executionResult.orderStatus.symbol !== intent.symbol) {
        throw new Error("Connector order status symbol does not match intent.");
      }
    }
    if (intent.action === "cex.place_order" && executionResult.orderStatus) {
      if (executionResult.orderStatus.symbol !== intent.symbol) {
        throw new Error("Connector order status symbol does not match intent.");
      }
      if (executionResult.orderStatus.side.toLowerCase() !== intent.side) {
        throw new Error("Connector order status side does not match intent.");
      }
      if (
        executionResult.orderId &&
        executionResult.orderStatus.orderId !== executionResult.orderId
      ) {
        throw new Error("Connector order status orderId does not match execution evidence.");
      }
    }
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

  private approvalMatchesIntent(
    request: ApprovalRequest,
    intent: TradingIntent,
    correlationId?: string,
  ): boolean {
    return (
      request.intentId === intent.intentId &&
      request.principal === intent.principal &&
      request.action === intent.action &&
      request.resource === intent.resource &&
      request.environment === intent.environment &&
      (correlationId === undefined || request.correlationId === correlationId) &&
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

  private decisionTokenMatches(
    approval: GuardrailApproval | GuardrailDryRunApproval,
    intent: TradingIntent,
  ): boolean {
    if (!/^[0-9a-f]{64}$/i.test(approval.decisionToken)) return false;
    const expected = createGuardrailDecisionToken({
      secret: this.config.decisionVerificationSecret,
      intent,
      outcome: approval.outcome,
      correlationId: approval.correlationId,
      decidedAt: approval.decidedAt,
      approvalId: "approvalId" in approval ? approval.approvalId : undefined,
      ...("dryRun" in approval && approval.dryRun ? { dryRun: true as const } : {}),
    });
    return timingSafeEqual(
      Buffer.from(approval.decisionToken, "hex"),
      Buffer.from(expected, "hex"),
    );
  }

  private assertKillSwitchAllowsExecution(
    scopes: KillSwitchScope[],
    intent: TradingIntent,
    correlationId: string,
  ): void {
    for (const scope of scopes) {
      let blocked: boolean;
      try {
        blocked = readKillSwitchBlocking(this.killSwitch, scope, intent);
      } catch {
        throw new ConnectorRevalidationError("Kill switch is not reachable.");
      }
      if (blocked) {
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
