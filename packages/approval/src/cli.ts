import type { ApprovalStore } from "./store.js";

export class ApprovalCli {
  constructor(private store: ApprovalStore) {}

  list(state?: "pending" | "approved" | "denied" | "timeout"): string {
    const requests = this.store.list(state ? { state } : undefined);
    if (requests.length === 0) return "No approval requests found.";
    return requests
      .map(
        (r) =>
          `[${r.approvalId.slice(0, 8)}] ${r.state.toUpperCase()} ${r.action} ${r.resource} (${r.escalationReason})`,
      )
      .join("\n");
  }

  show(approvalId: string): string {
    const request = this.store.get(approvalId);
    if (!request) return `Approval ${approvalId} not found.`;
    return JSON.stringify(request, null, 2);
  }

  approve(approvalId: string, decidedBy: string): string {
    const result = this.store.approve(approvalId, decidedBy);
    if (!result) return `Cannot approve ${approvalId} — not pending or timed out.`;
    return `Approved ${approvalId} by ${decidedBy}.`;
  }

  deny(approvalId: string, decidedBy: string): string {
    const result = this.store.deny(approvalId, decidedBy);
    if (!result) return `Cannot deny ${approvalId} — not pending or timed out.`;
    return `Denied ${approvalId} by ${decidedBy}.`;
  }

  watch(callback: (message: string) => void): () => void {
    const interval = setInterval(() => {
      const pending = this.store.list({ state: "pending" });
      if (pending.length > 0) {
        callback(`${pending.length} pending approval(s):\n${this.list("pending")}`);
      }
      this.store.checkTimeouts();
    }, 2000);
    return () => clearInterval(interval);
  }
}
