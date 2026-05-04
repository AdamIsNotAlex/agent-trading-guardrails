import { randomUUID } from "node:crypto";
import type { ApprovalConfig, ApprovalRequest, ApprovalState, ApprovalType } from "./interfaces.js";

export class ApprovalStore {
  private requests = new Map<string, ApprovalRequest>();

  constructor(private config: ApprovalConfig) {}

  create(params: {
    intentId: string;
    correlationId: string;
    principal: string;
    action: string;
    resource: string;
    environment: string;
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
    request.state = "approved";
    request.decidedAt = new Date().toISOString();
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
