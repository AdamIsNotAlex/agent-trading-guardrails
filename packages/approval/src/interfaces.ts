import type { Environment } from "@guardrails/schemas";

export type ApprovalState = "pending" | "approved" | "denied" | "timeout" | "consumed";
export type ApprovalType = "one_time" | "allowlist_onboarding";

interface ApprovalRequestBase {
  approvalId: string;
  intentId: string;
  correlationId: string;
  principal: string;
  action: string;
  resource: string;
  environment: Environment;
  escalationReason: string;
  approvalType: ApprovalType;
  intentData: Record<string, unknown>;
  createdAt: string;
  timeoutAt: string;
}

export type PendingApprovalRequest = ApprovalRequestBase & {
  state: "pending";
  decidedAt: null;
  decidedBy: null;
};

export type ApprovedApprovalRequest = ApprovalRequestBase & {
  state: "approved";
  decidedAt: string;
  decidedBy: string;
};

export type DeniedApprovalRequest = ApprovalRequestBase & {
  state: "denied";
  decidedAt: string;
  decidedBy: string;
};

export type TimeoutApprovalRequest = ApprovalRequestBase & {
  state: "timeout";
  decidedAt: string;
  decidedBy: null;
};

export type ConsumedApprovalRequest = ApprovalRequestBase & {
  state: "consumed";
  decidedAt: string;
  decidedBy: string;
};

export type ApprovalRequest =
  | PendingApprovalRequest
  | ApprovedApprovalRequest
  | DeniedApprovalRequest
  | TimeoutApprovalRequest
  | ConsumedApprovalRequest;

export interface AllowlistOnboardingEntry {
  name: string;
  effect: "allow";
  principal: string;
  action: string;
  resource: string;
  condition: Record<string, unknown>;
}

export interface AllowlistOnboardingStore {
  add(entry: AllowlistOnboardingEntry): () => void;
}

export interface ApprovalAuditWriter {
  write(event: {
    eventType: "approval.approved" | "approval.denied" | "approval.timeout" | "allowlist.updated";
    environment: Environment;
    intentId: string;
    principal: string;
    correlationId: string;
    data: Record<string, unknown>;
  }): void;
}

export interface ApprovalConfig {
  defaultTimeoutSeconds: number;
  audit?: ApprovalAuditWriter;
  allowlistOnboarding?: {
    store: AllowlistOnboardingStore;
    audit: ApprovalAuditWriter;
  };
}

export interface ApprovalNotifier {
  notify(request: ApprovalRequest): Promise<void>;
}
