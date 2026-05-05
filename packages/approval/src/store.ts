import { randomUUID } from "node:crypto";
import type { Environment } from "@guardrails/schemas";
import type {
  AllowlistOnboardingEntry,
  ApprovalConfig,
  ApprovalRequest,
  ApprovalState,
  ApprovalType,
} from "./interfaces.js";

export class ApprovalStore {
  private requests = new Map<string, ApprovalRequest>();

  constructor(private config: ApprovalConfig) {}

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
    this.requests.set(request.approvalId, request);
    return request;
  }

  waitForApproval(approvalId: string, timeoutMs: number, pollMs = 50): Promise<ApprovalRequest> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const request = this.requests.get(approvalId);
        if (!request) {
          reject(new Error(`Approval request ${approvalId} was not found.`));
          return;
        }
        if (new Date() > new Date(request.timeoutAt)) {
          try {
            this.timeout(request, new Date().toISOString());
          } catch (err) {
            reject(err);
            return;
          }
          reject(new Error(`Approval request ${approvalId} timed out.`));
          return;
        }
        if (request.state === "approved") {
          resolve(request);
          return;
        }
        if (request.state === "denied") {
          reject(new Error(`Approval request ${approvalId} was denied.`));
          return;
        }
        if (request.state === "timeout") {
          reject(new Error(`Approval request ${approvalId} timed out.`));
          return;
        }
        if (request.state === "consumed") {
          reject(new Error(`Approval request ${approvalId} was already used.`));
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for approval request ${approvalId}.`));
          return;
        }
        setTimeout(poll, pollMs);
      };
      poll();
    });
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return this.requests.get(approvalId);
  }

  delete(approvalId: string): boolean {
    return this.requests.delete(approvalId);
  }

  list(filter?: { state?: ApprovalState }): ApprovalRequest[] {
    const all = [...this.requests.values()];
    if (filter?.state) return all.filter((r) => r.state === filter.state);
    return all;
  }

  approve(approvalId: string, decidedBy: string): ApprovalRequest | null {
    const request = this.requests.get(approvalId);
    if (!request || request.state !== "pending") return null;
    const decidedAt = new Date().toISOString();
    if (new Date() > new Date(request.timeoutAt)) {
      this.timeout(request, decidedAt);
      return null;
    }
    let onboarding: { rollback(): void; entry: AllowlistOnboardingEntry } | null = null;
    if (request.approvalType === "allowlist_onboarding") {
      onboarding = this.applyAllowlistOnboarding(request, decidedBy, decidedAt);
    }
    try {
      this.writeDecisionAudit(request, "approval.approved", decidedBy, decidedAt, "approved");
    } catch (err) {
      if (onboarding) {
        onboarding.rollback();
        this.writeAllowlistRollbackAudit(request, decidedBy, decidedAt, onboarding.entry);
      }
      throw err;
    }
    request.state = "approved";
    request.decidedAt = decidedAt;
    request.decidedBy = decidedBy;
    return request;
  }

  deny(approvalId: string, decidedBy: string): ApprovalRequest | null {
    const request = this.requests.get(approvalId);
    if (!request || request.state !== "pending") return null;
    const decidedAt = new Date().toISOString();
    if (new Date() > new Date(request.timeoutAt)) {
      this.timeout(request, decidedAt);
      return null;
    }
    this.writeDecisionAudit(request, "approval.denied", decidedBy, decidedAt, "denied");
    request.state = "denied";
    request.decidedAt = decidedAt;
    request.decidedBy = decidedBy;
    return request;
  }

  consumeOneTime(approvalId: string): ApprovalRequest | null {
    const request = this.requests.get(approvalId);
    if (!request || request.state !== "approved" || request.approvalType !== "one_time") {
      return null;
    }
    const now = new Date();
    if (now > new Date(request.timeoutAt)) {
      this.timeout(request, now.toISOString());
      return null;
    }
    request.state = "consumed";
    return request;
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

  private timeout(request: ApprovalRequest, decidedAt: string): void {
    this.writeDecisionAudit(request, "approval.timeout", null, decidedAt, "timeout");
    request.state = "timeout";
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
    const now = new Date();
    const timedOut: ApprovalRequest[] = [];
    for (const request of this.requests.values()) {
      if (request.state === "pending" && now > new Date(request.timeoutAt)) {
        this.timeout(request, now.toISOString());
        timedOut.push(request);
      }
    }
    return timedOut;
  }
}
