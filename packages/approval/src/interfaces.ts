export type ApprovalState = "pending" | "approved" | "denied" | "timeout";
export type ApprovalType = "one_time" | "allowlist_onboarding";

export interface ApprovalRequest {
  approvalId: string;
  intentId: string;
  correlationId: string;
  principal: string;
  action: string;
  resource: string;
  environment: string;
  escalationReason: string;
  approvalType: ApprovalType;
  state: ApprovalState;
  intentData: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  timeoutAt: string;
}

export interface ApprovalConfig {
  defaultTimeoutSeconds: number;
}

export interface ApprovalNotifier {
  notify(request: ApprovalRequest): Promise<void>;
}
