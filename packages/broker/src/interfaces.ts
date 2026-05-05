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

export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Idempotency key ${key} was already used with a different intent payload.`);
    this.name = "IdempotencyConflictError";
  }
}

export type BrokerIdempotencyReservation =
  | {
      status: "reserved";
      complete(result: BrokerExecutionResult): void;
      abort(error: unknown): void;
    }
  | { status: "cached"; result: BrokerExecutionResult }
  | { status: "pending"; result: Promise<BrokerExecutionResult> };

export interface BrokerIdempotencyStore {
  begin(key: string, intent: TradingIntent): BrokerIdempotencyReservation;
}
