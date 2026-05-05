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

  get(approvalId: string): ApprovalRequest | undefined {
    return this.requests.get(approvalId);
  }

  list(filter?: { state?: ApprovalState }): ApprovalRequest[] {
    const all = [...this.requests.values()];
    if (filter?.state) return all.filter((r) => r.state === filter.state);
    return all;
  }

  approve(approvalId: string, decidedBy: string): ApprovalRequest | null {
    const request = this.requests.get(approvalId);
    if (!request || request.state !== "pending") return null;
    if (new Date() > new Date(request.timeoutAt)) {
      request.state = "timeout";
      return null;
    }
    const decidedAt = new Date().toISOString();
    if (request.approvalType === "allowlist_onboarding") {
      this.applyAllowlistOnboarding(request, decidedBy, decidedAt);
    }
    request.state = "approved";
    request.decidedAt = decidedAt;
    request.decidedBy = decidedBy;
    return request;
  }

  deny(approvalId: string, decidedBy: string): ApprovalRequest | null {
    const request = this.requests.get(approvalId);
    if (!request || request.state !== "pending") return null;
    request.state = "denied";
    request.decidedAt = new Date().toISOString();
    request.decidedBy = decidedBy;
    return request;
  }

  private applyAllowlistOnboarding(
    request: ApprovalRequest,
    decidedBy: string,
    decidedAt: string,
  ): void {
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
        request.state = "timeout";
        timedOut.push(request);
      }
    }
    return timedOut;
  }
}
