import type {
  AuditEventType,
  BrokerExecutionResult,
  BrokerSimulationEvidence,
  Environment,
  TradingIntent,
} from "@guardrails/schemas";

export interface ConnectorOrderStatus {
  orderId: string;
  symbol: string;
  side: string;
  status: string;
  executedQty: number;
  avgPrice: number;
}

export type BeforeConnectorSideEffect = () => void;

interface ConnectorExecutionEvidence {
  orderId?: string;
  transactionHash?: string;
  orderStatus?: ConnectorOrderStatus;
  simulationEvidence?: BrokerSimulationEvidence;
}

type RequireExecutionEvidence<T, K extends keyof T> = T &
  {
    [P in K]-?: Required<Pick<T, P>> & Partial<Pick<T, Exclude<K, P>>>;
  }[K];

export type ConnectorExecutionResult = RequireExecutionEvidence<
  ConnectorExecutionEvidence,
  "orderId" | "transactionHash" | "orderStatus" | "simulationEvidence"
>;

export interface ExecutionConnector {
  execute(
    intent: TradingIntent,
    beforeSideEffect?: BeforeConnectorSideEffect,
  ): Promise<ConnectorExecutionResult>;
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
  write(event: BrokerAuditEvent): void;
}

export interface BrokerAuditEvent {
  eventId?: string;
  eventType: AuditEventType;
  environment: Environment;
  intentId?: string;
  principal?: string;
  correlationId: string;
  data: Record<string, unknown>;
}

export class ConnectorRevalidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorRevalidationError";
  }
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
      complete(result: BrokerExecutionResult, pendingAudit?: BrokerAuditEvent): void;
      completeAudit(): void;
      failAudit(error: unknown): void;
      abort(error: unknown): void;
    }
  | {
      status: "cached";
      result: BrokerExecutionResult;
      pendingAudit?: BrokerAuditEvent;
      completeAudit(): void;
    }
  | { status: "pending"; result: Promise<BrokerExecutionResult> };

export interface BrokerIdempotencyStore {
  begin(key: string, intent: TradingIntent): BrokerIdempotencyReservation;
}
