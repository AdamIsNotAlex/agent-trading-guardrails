import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { Environment } from "@guardrails/schemas";
import Database from "better-sqlite3";
import type {
  AllowlistOnboardingEntry,
  ApprovalConfig,
  ApprovalRequest,
  ApprovalState,
  ApprovalType,
} from "./interfaces.js";
import { approvalRequestSchema } from "./request-schema.js";

type PendingApprovalRequest = Extract<ApprovalRequest, { state: "pending" }>;
type TimeoutApprovalRequest = Extract<ApprovalRequest, { state: "timeout" }>;

export class ApprovalStore {
  private readonly database: Database.Database;
  private readonly selectRequest: Database.Statement;
  private readonly selectAll: Database.Statement;
  private readonly selectState: Database.Statement;
  private readonly selectExpired: Database.Statement;
  private readonly insertRequest: Database.Statement;
  private readonly updateRequest: Database.Statement;
  private readonly deleteRequest: Database.Statement;

  constructor(private config: ApprovalConfig) {
    const path = config.databasePath ?? process.env.APPROVAL_DB_PATH ?? "./data/approvals.db";
    if (!path.trim()) throw new Error("Approval database path must not be empty.");
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, "a", 0o600));
    }
    this.database = new Database(path, { timeout: 5000 });
    try {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = FULL");
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS approval_requests (
          approval_id TEXT PRIMARY KEY NOT NULL,
          request TEXT NOT NULL CHECK (json_valid(request)),
          state TEXT GENERATED ALWAYS AS (json_extract(request, '$.state')) VIRTUAL NOT NULL
            CHECK (state IN ('pending', 'approved', 'denied', 'timeout', 'consumed')),
          timeout_at TEXT GENERATED ALWAYS AS (json_extract(request, '$.timeoutAt')) VIRTUAL NOT NULL,
          CHECK (approval_id = json_extract(request, '$.approvalId'))
        );
        CREATE INDEX IF NOT EXISTS approval_requests_state_timeout
          ON approval_requests (state, timeout_at);
      `);
      this.selectRequest = this.database.prepare(
        "SELECT request FROM approval_requests WHERE approval_id = ?",
      );
      this.selectAll = this.database.prepare(
        "SELECT request FROM approval_requests ORDER BY rowid",
      );
      this.selectState = this.database.prepare(
        "SELECT request FROM approval_requests WHERE state = ? ORDER BY rowid",
      );
      this.selectExpired = this.database.prepare(
        "SELECT approval_id FROM approval_requests WHERE state = 'pending' AND timeout_at <= ?",
      );
      this.insertRequest = this.database.prepare(
        "INSERT INTO approval_requests (approval_id, request) VALUES (?, ?)",
      );
      this.updateRequest = this.database.prepare(
        "UPDATE approval_requests SET request = ? WHERE approval_id = ?",
      );
      this.deleteRequest = this.database.prepare(
        "DELETE FROM approval_requests WHERE approval_id = ?",
      );
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  create(params: {
    intentId: string;
    correlationId: string;
    principal: string;
    action: string;
    resource: string;
    environment: Environment;
    escalationReason: string;
    approvalType: ApprovalType;
    intentData: Record<string, unknown>;
  }): ApprovalRequest {
    const now = new Date();
    const request: ApprovalRequest = {
      approvalId: randomUUID(),
      ...params,
      state: "pending",
      createdAt: now.toISOString(),
      decidedAt: null,
      decidedBy: null,
      timeoutAt: new Date(now.getTime() + this.config.defaultTimeoutSeconds * 1000).toISOString(),
    };
    this.insertRequest.run(request.approvalId, JSON.stringify(request));
    return request;
  }

  waitForApproval(approvalId: string, timeoutMs: number, pollMs = 50): Promise<ApprovalRequest> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        try {
          const request = this.get(approvalId);
          if (!request) throw new Error(`Approval request ${approvalId} was not found.`);
          if (Date.now() >= Date.parse(request.timeoutAt)) {
            if (request.state === "pending") this.expire(approvalId);
            throw new Error(`Approval request ${approvalId} timed out.`);
          }
          if (request.state === "approved") {
            resolve(request);
            return;
          }
          if (request.state === "denied") {
            throw new Error(`Approval request ${approvalId} was denied.`);
          }
          if (request.state === "timeout") {
            throw new Error(`Approval request ${approvalId} timed out.`);
          }
          if (request.state === "consumed") {
            throw new Error(`Approval request ${approvalId} was already used.`);
          }
          if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for approval request ${approvalId}.`);
          }
          setTimeout(poll, pollMs);
        } catch (error) {
          reject(error);
        }
      };
      poll();
    });
  }

  get(approvalId: string): ApprovalRequest | undefined {
    const row = this.selectRequest.get(approvalId) as { request: string } | undefined;
    return row ? approvalRequestSchema.parse(JSON.parse(row.request)) : undefined;
  }

  delete(approvalId: string): boolean {
    return this.deleteRequest.run(approvalId).changes > 0;
  }

  list(filter?: { state?: ApprovalState }): ApprovalRequest[] {
    const rows = (filter?.state ? this.selectState.all(filter.state) : this.selectAll.all()) as {
      request: string;
    }[];
    return rows.map((row) => approvalRequestSchema.parse(JSON.parse(row.request)));
  }

  // Lock before reading state so only the winning process performs decision side effects.
  approve(approvalId: string, decidedBy: string): ApprovalRequest | null {
    return this.database
      .transaction(() => {
        const request = this.get(approvalId);
        if (!request || request.state !== "pending") return null;
        const decidedAt = new Date().toISOString();
        if (decidedAt >= request.timeoutAt) {
          this.timeout(request, decidedAt);
          return null;
        }
        let onboarding: { rollback(): void; entry: AllowlistOnboardingEntry } | null = null;
        if (request.approvalType === "allowlist_onboarding") {
          onboarding = this.applyAllowlistOnboarding(request, decidedBy, decidedAt);
        }
        try {
          this.writeDecisionAudit(request, "approval.approved", decidedBy, decidedAt, "approved");
          return this.save({ ...request, state: "approved", decidedAt, decidedBy });
        } catch (err) {
          if (onboarding) {
            onboarding.rollback();
            this.writeAllowlistRollbackAudit(request, decidedBy, decidedAt, onboarding.entry);
          }
          throw err;
        }
      })
      .immediate();
  }

  deny(approvalId: string, decidedBy: string): ApprovalRequest | null {
    return this.database
      .transaction(() => {
        const request = this.get(approvalId);
        if (!request || request.state !== "pending") return null;
        const decidedAt = new Date().toISOString();
        if (decidedAt >= request.timeoutAt) {
          this.timeout(request, decidedAt);
          return null;
        }
        this.writeDecisionAudit(request, "approval.denied", decidedBy, decidedAt, "denied");
        return this.save({ ...request, state: "denied", decidedAt, decidedBy });
      })
      .immediate();
  }

  consumeOneTime(approvalId: string): ApprovalRequest | null {
    return this.database
      .transaction(() => {
        const request = this.get(approvalId);
        if (!request || request.state !== "approved" || request.approvalType !== "one_time") {
          return null;
        }
        if (Date.now() >= Date.parse(request.timeoutAt)) return null;
        return this.save({ ...request, state: "consumed" });
      })
      .immediate();
  }

  private applyAllowlistOnboarding(
    request: ApprovalRequest,
    decidedBy: string,
    decidedAt: string,
  ): { rollback(): void; entry: AllowlistOnboardingEntry } {
    if (!this.config.allowlistOnboarding) {
      throw new Error("Allowlist onboarding persistence is not configured.");
    }
    const entry = this.buildAllowlistEntry(request);
    const rollback = this.config.allowlistOnboarding.store.add(entry);
    try {
      this.config.allowlistOnboarding.audit.write({
        eventType: "allowlist.updated",
        environment: request.environment,
        intentId: request.intentId,
        principal: request.principal,
        correlationId: request.correlationId,
        data: {
          approvalId: request.approvalId,
          updatedBy: decidedBy,
          updatedAt: decidedAt,
          policyEntry: entry,
        },
      });
    } catch (err) {
      rollback();
      throw err;
    }
    return { rollback, entry };
  }

  private writeAllowlistRollbackAudit(
    request: ApprovalRequest,
    decidedBy: string,
    decidedAt: string,
    entry: AllowlistOnboardingEntry,
  ): void {
    this.config.allowlistOnboarding?.audit.write({
      eventType: "allowlist.updated",
      environment: request.environment,
      intentId: request.intentId,
      principal: request.principal,
      correlationId: request.correlationId,
      data: {
        approvalId: request.approvalId,
        updatedBy: decidedBy,
        updatedAt: decidedAt,
        policyEntry: entry,
        rolledBack: true,
      },
    });
  }

  private timeout(request: PendingApprovalRequest, decidedAt: string): TimeoutApprovalRequest {
    this.writeDecisionAudit(request, "approval.timeout", null, decidedAt, "timeout");
    return this.save({ ...request, state: "timeout", decidedAt, decidedBy: null });
  }

  private save<T extends ApprovalRequest>(request: T): T {
    this.updateRequest.run(JSON.stringify(request), request.approvalId);
    return request;
  }

  private expire(approvalId: string): TimeoutApprovalRequest | null {
    return this.database
      .transaction(() => {
        const request = this.get(approvalId);
        const now = new Date().toISOString();
        if (!request || request.state !== "pending" || now < request.timeoutAt) return null;
        return this.timeout(request, now);
      })
      .immediate();
  }

  private writeDecisionAudit(
    request: ApprovalRequest,
    eventType: "approval.approved" | "approval.denied" | "approval.timeout",
    decidedBy: string | null,
    decidedAt: string,
    state: ApprovalState,
  ): void {
    const audit = this.config.audit ?? this.config.allowlistOnboarding?.audit;
    audit?.write({
      eventType,
      environment: request.environment,
      intentId: request.intentId,
      principal: request.principal,
      correlationId: request.correlationId,
      data: {
        approvalId: request.approvalId,
        approvalType: request.approvalType,
        decidedBy,
        decidedAt,
        state,
      },
    });
  }

  private buildAllowlistEntry(request: ApprovalRequest): AllowlistOnboardingEntry {
    return {
      name: `approval-${request.approvalId}`,
      effect: "allow",
      principal: request.principal,
      action: request.action,
      resource: request.resource,
      condition: this.buildAllowlistCondition(request),
    };
  }

  private buildAllowlistCondition(request: ApprovalRequest): Record<string, unknown> {
    const condition: Record<string, unknown> = {
      environment: request.environment,
      requiresHumanApproval: false,
    };
    if (typeof request.intentData.accountMode === "string") {
      condition.accountMode = request.intentData.accountMode;
    }
    if (typeof request.intentData.maxNotionalUsd === "number") {
      condition.maxNotionalUsd = request.intentData.maxNotionalUsd;
    }
    if (typeof request.intentData.leverage === "number") {
      condition.maxLeverage = request.intentData.leverage;
    }
    return condition;
  }

  checkTimeouts(): ApprovalRequest[] {
    const expired = this.selectExpired.all(new Date().toISOString()) as { approval_id: string }[];
    const timedOut: ApprovalRequest[] = [];
    for (const row of expired) {
      const request = this.expire(row.approval_id);
      if (request) timedOut.push(request);
    }
    return timedOut;
  }
}
