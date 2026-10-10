import type { Environment, TradingIntent } from "@guardrails/schemas";
import {
  type AuditWriter,
  type KillSwitch,
  KillSwitchReachabilityError,
  type KillSwitchScope,
} from "./interfaces.js";

export interface PreflightCheckResult {
  check: string;
  passed: boolean;
  message?: string;
}

export interface LiveModePreflightCheckParams {
  audit: AuditWriter;
  killSwitch: KillSwitch;
  approvalStore?: { liveConfigured?(): boolean; checkHealth?(): void };
  environment: Environment;
  intent: TradingIntent;
  correlationId: string;
}

export function getKillSwitchScopes(intent: TradingIntent): KillSwitchScope[] {
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

export function readKillSwitchActive(killSwitch: KillSwitch, scope: KillSwitchScope): boolean {
  let active: unknown;
  try {
    active = killSwitch.isActive(scope);
  } catch (err) {
    throw new KillSwitchReachabilityError(err);
  }
  if (typeof active !== "boolean") {
    throw new KillSwitchReachabilityError();
  }
  return active;
}

export class LiveModePreflightCheck {
  constructor(private params: LiveModePreflightCheckParams) {}

  run(): { passed: boolean; checks: PreflightCheckResult[] } {
    const checks = [this.checkKillSwitch(), this.checkAudit(), this.checkApproval()];
    if (
      !this.writeSummary(
        checks.every((check) => check.passed),
        checks,
      )
    ) {
      this.recordFailedAuditCheck(checks, "Audit preflight summary could not be written.");
    }
    return { passed: checks.every((check) => check.passed), checks };
  }

  private checkKillSwitch(): PreflightCheckResult {
    try {
      for (const scope of getKillSwitchScopes(this.params.intent)) {
        if (readKillSwitchActive(this.params.killSwitch, scope)) {
          return { check: "kill_switch", passed: false, message: "Kill switch is active." };
        }
      }
      return { check: "kill_switch", passed: true };
    } catch {
      return {
        check: "kill_switch",
        passed: false,
        message: "Kill switch is not reachable.",
      };
    }
  }

  private checkAudit(): PreflightCheckResult {
    if (typeof this.params.audit.checkHealth !== "function") {
      return {
        check: "audit",
        passed: false,
        message: "Audit writer health check is not available.",
      };
    }
    try {
      this.params.audit.checkHealth();
      return { check: "audit", passed: true };
    } catch {
      return {
        check: "audit",
        passed: false,
        message: "Audit writer health check failed.",
      };
    }
  }

  private checkApproval(): PreflightCheckResult {
    if (typeof this.params.approvalStore?.checkHealth !== "function") {
      return {
        check: "approval",
        passed: false,
        message: "Approval store health check is not available.",
      };
    }
    try {
      if (
        typeof this.params.approvalStore.liveConfigured !== "function" ||
        this.params.approvalStore.liveConfigured() !== true
      ) {
        return {
          check: "approval",
          passed: false,
          message: "Approval store is not explicitly configured for live trading.",
        };
      }
      this.params.approvalStore.checkHealth();
      return { check: "approval", passed: true };
    } catch {
      return {
        check: "approval",
        passed: false,
        message: "Approval store health check failed.",
      };
    }
  }

  private writeSummary(passed: boolean, checks: PreflightCheckResult[]): boolean {
    if (!this.params.correlationId) {
      return false;
    }
    try {
      this.params.audit.write({
        eventType: "broker.preflight",
        environment: this.params.environment,
        intentId: this.params.intent.intentId,
        principal: this.params.intent.principal,
        correlationId: this.params.correlationId,
        data: { passed, checks },
      });
      return true;
    } catch {
      return false;
    }
  }

  private recordFailedAuditCheck(checks: PreflightCheckResult[], message: string): void {
    const auditIndex = checks.findIndex((check) => check.check === "audit");
    const failed = { check: "audit", passed: false, message };
    if (auditIndex === -1) {
      checks.push(failed);
      return;
    }
    if (checks[auditIndex]?.passed) {
      checks[auditIndex] = failed;
    }
  }
}
