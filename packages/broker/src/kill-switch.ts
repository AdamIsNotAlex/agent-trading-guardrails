import { randomUUID } from "node:crypto";
import type { Environment } from "@guardrails/schemas";
import type { AuditWriter, KillSwitch, KillSwitchScope } from "./interfaces.js";

export class InMemoryKillSwitch implements KillSwitch {
  private active = new Set<string>();
  private audit?: AuditWriter;
  private environment: Environment;

  constructor(audit?: AuditWriter, environment?: Environment) {
    if (audit && !environment) {
      throw new Error("Kill switch audit requires an environment.");
    }
    this.audit = audit;
    this.environment = environment ?? "dev";
  }

  private key(scope: KillSwitchScope): string {
    switch (scope.type) {
      case "global":
        return "global";
      case "agent":
        return `agent:${scope.principal}`;
      case "account":
        return `account:${scope.account}`;
      case "exchange":
        return `exchange:${scope.exchange}`;
      case "chain":
        return `chain:${scope.chain}`;
    }
  }

  isActive(scope: KillSwitchScope): boolean {
    if (this.active.has("global")) return true;
    return this.active.has(this.key(scope));
  }

  activate(scope: KillSwitchScope): void {
    this.audit?.write({
      eventType: "killswitch.activated",
      environment: this.environment,
      correlationId: randomUUID(),
      ...(scope.type === "agent" ? { principal: scope.principal } : {}),
      data: { scope },
    });
    this.active.add(this.key(scope));
  }

  deactivate(scope: KillSwitchScope): void {
    this.active.delete(this.key(scope));
  }
}
