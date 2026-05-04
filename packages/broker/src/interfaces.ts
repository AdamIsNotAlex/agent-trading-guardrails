import type {
  AuditEventType,
  BrokerExecutionResult,
  Environment,
  TradingIntent,
} from "@guardrails/schemas";

export interface ExecutionConnector {
  execute(intent: TradingIntent): Promise<{ orderId?: string; transactionHash?: string }>;
  revalidate(intent: TradingIntent): Promise<{ passed: boolean; reason?: string }>;
}

export interface KillSwitch {
  isActive(scope: KillSwitchScope): boolean;
  activate(scope: KillSwitchScope): void;
  deactivate(scope: KillSwitchScope): void;
}

export type KillSwitchScope =
  | { type: "global" }
  | { type: "agent"; principal: string }
  | { type: "account"; account: string }
  | { type: "exchange"; exchange: string }
  | { type: "chain"; chain: string };

export interface AuditWriter {
  write(event: {
    eventType: AuditEventType;
    environment: Environment;
    intentId?: string;
    principal?: string;
    correlationId: string;
    data: Record<string, unknown>;
  }): void;
}

export interface BrokerIdempotencyStore {
  get(key: string): BrokerExecutionResult | undefined;
  set(key: string, result: BrokerExecutionResult): void;
}
