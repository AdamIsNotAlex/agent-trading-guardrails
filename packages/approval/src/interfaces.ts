import type { Environment } from "@guardrails/schemas";

export type ApprovalState = "pending" | "approved" | "denied" | "timeout";
export type ApprovalType = "one_time" | "allowlist_onboarding";

export interface ApprovalRequest {
  approvalId: string;
  intentId: string;
  correlationId: string;
  principal: string;
  action: string;
  resource: string;
  environment: Environment;
  escalationReason: string;
  approvalType: ApprovalType;
  state: ApprovalState;
  intentData: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  timeoutAt: string;
}

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
    eventType: "allowlist.updated";
    environment: Environment;
    intentId: string;
    principal: string;
    correlationId: string;
    data: Record<string, unknown>;
  }): void;
}

export interface ApprovalConfig {
  defaultTimeoutSeconds: number;
  allowlistOnboarding?: {
    store: AllowlistOnboardingStore;
    audit: ApprovalAuditWriter;
  };
}

export interface ApprovalNotifier {
  notify(request: ApprovalRequest): Promise<void>;
}
