import { z } from "zod";

export const BrokerExecutionStatus = z.enum(["executed", "rejected", "failed"]);
export type BrokerExecutionStatus = z.infer<typeof BrokerExecutionStatus>;

export const BrokerOrderStatus = z
  .object({
    orderId: z.string().min(1),
    symbol: z.string().min(1),
    side: z.string().min(1),
    status: z.string().min(1),
    executedQty: z.number().finite().nonnegative(),
    avgPrice: z.number().finite().nonnegative(),
  })
  .strict();
export type BrokerOrderStatus = z.infer<typeof BrokerOrderStatus>;

export const BrokerExecutionKind = z.enum([
  "cex_order",
  "cex_cancel",
  "cex_order_status",
  "onchain_signature",
  "onchain_simulation",
]);
export type BrokerExecutionKind = z.infer<typeof BrokerExecutionKind>;

export const BrokerSimulationEvidence = z
  .object({
    simulationId: z.string().uuid().optional(),
    provider: z.string().min(1),
  })
  .strict();
export type BrokerSimulationEvidence = z.infer<typeof BrokerSimulationEvidence>;

const BrokerExecutionResultBase = z
  .object({
    intentId: z.string().uuid(),
    idempotencyKey: z.string().min(1),
    revalidationPassed: z.boolean(),
    executedAt: z.string().datetime(),
  })
  .strict();

const ExecutedCexOrderByIdResult = BrokerExecutionResultBase.extend({
  status: z.literal("executed"),
  executionKind: z.literal("cex_order"),
  revalidationPassed: z.literal(true),
  orderId: z.string().min(1),
});

const ExecutedCexOrderByStatusResult = BrokerExecutionResultBase.extend({
  status: z.literal("executed"),
  executionKind: z.literal("cex_order"),
  revalidationPassed: z.literal(true),
  orderStatus: BrokerOrderStatus,
});

const ExecutedCexOrderByIdAndStatusResult = BrokerExecutionResultBase.extend({
  status: z.literal("executed"),
  executionKind: z.literal("cex_order"),
  revalidationPassed: z.literal(true),
  orderId: z.string().min(1),
  orderStatus: BrokerOrderStatus,
});

const ExecutedCexCancelResult = BrokerExecutionResultBase.extend({
  status: z.literal("executed"),
  executionKind: z.literal("cex_cancel"),
  revalidationPassed: z.literal(true),
  orderId: z.string().min(1),
});

const ExecutedCexOrderStatusResult = BrokerExecutionResultBase.extend({
  status: z.literal("executed"),
  executionKind: z.literal("cex_order_status"),
  revalidationPassed: z.literal(true),
  orderId: z.string().min(1).optional(),
  orderStatus: BrokerOrderStatus,
});

const ExecutedOnchainSigningResult = BrokerExecutionResultBase.extend({
  status: z.literal("executed"),
  executionKind: z.literal("onchain_signature"),
  revalidationPassed: z.literal(true),
  transactionHash: z.string().min(1),
});

const ExecutedOnchainSimulationResult = BrokerExecutionResultBase.extend({
  status: z.literal("executed"),
  executionKind: z.literal("onchain_simulation"),
  revalidationPassed: z.literal(true),
  simulationEvidence: BrokerSimulationEvidence,
});

const RejectedBrokerExecutionResult = BrokerExecutionResultBase.extend({
  status: z.literal("rejected"),
  rejectionReason: z.string().min(1),
});

const FailedBrokerExecutionResult = BrokerExecutionResultBase.extend({
  status: z.literal("failed"),
  rejectionReason: z.string().min(1),
});

export const BrokerExecutionResult = z.union([
  ExecutedCexOrderByIdResult,
  ExecutedCexOrderByStatusResult,
  ExecutedCexOrderByIdAndStatusResult,
  ExecutedCexCancelResult,
  ExecutedCexOrderStatusResult,
  ExecutedOnchainSigningResult,
  ExecutedOnchainSimulationResult,
  RejectedBrokerExecutionResult,
  FailedBrokerExecutionResult,
]);

interface BrokerExecutionResultTypeBase {
  intentId: string;
  idempotencyKey: string;
  executedAt: string;
}

type BrokerExecutionResultNoRejectionEvidence = {
  rejectionReason?: never;
};

type BrokerExecutionResultNoOrderEvidence = {
  orderId?: never;
  orderStatus?: never;
};

type BrokerExecutionResultNoOnchainEvidence = {
  transactionHash?: never;
  simulationEvidence?: never;
};

type BrokerExecutedCexOrderResult = BrokerExecutionResultTypeBase &
  BrokerExecutionResultNoRejectionEvidence &
  BrokerExecutionResultNoOnchainEvidence & {
    status: "executed";
    executionKind: "cex_order";
    revalidationPassed: true;
  } & (
    | { orderId: string; orderStatus?: BrokerOrderStatus }
    | { orderId?: string; orderStatus: BrokerOrderStatus }
  );

type BrokerExecutedCexCancelResult = BrokerExecutionResultTypeBase &
  BrokerExecutionResultNoRejectionEvidence &
  BrokerExecutionResultNoOnchainEvidence & {
    status: "executed";
    executionKind: "cex_cancel";
    revalidationPassed: true;
    orderId: string;
    orderStatus?: never;
  };

type BrokerExecutedCexOrderStatusResult = BrokerExecutionResultTypeBase &
  BrokerExecutionResultNoRejectionEvidence &
  BrokerExecutionResultNoOnchainEvidence & {
    status: "executed";
    executionKind: "cex_order_status";
    revalidationPassed: true;
    orderId?: string;
    orderStatus: BrokerOrderStatus;
  };

type BrokerExecutedOnchainSigningResult = BrokerExecutionResultTypeBase &
  BrokerExecutionResultNoRejectionEvidence &
  BrokerExecutionResultNoOrderEvidence & {
    status: "executed";
    executionKind: "onchain_signature";
    revalidationPassed: true;
    transactionHash: string;
    simulationEvidence?: never;
  };

type BrokerExecutedOnchainSimulationResult = BrokerExecutionResultTypeBase &
  BrokerExecutionResultNoRejectionEvidence &
  BrokerExecutionResultNoOrderEvidence & {
    status: "executed";
    executionKind: "onchain_simulation";
    revalidationPassed: true;
    transactionHash?: never;
    simulationEvidence: BrokerSimulationEvidence;
  };

type BrokerRejectedExecutionResult = BrokerExecutionResultTypeBase &
  BrokerExecutionResultNoOrderEvidence &
  BrokerExecutionResultNoOnchainEvidence & {
    status: "rejected";
    executionKind?: never;
    revalidationPassed: boolean;
    rejectionReason: string;
  };

type BrokerFailedExecutionResult = BrokerExecutionResultTypeBase &
  BrokerExecutionResultNoOrderEvidence &
  BrokerExecutionResultNoOnchainEvidence & {
    status: "failed";
    executionKind?: never;
    revalidationPassed: boolean;
    rejectionReason: string;
  };

export type BrokerExecutionResult =
  | BrokerExecutedCexOrderResult
  | BrokerExecutedCexCancelResult
  | BrokerExecutedCexOrderStatusResult
  | BrokerExecutedOnchainSigningResult
  | BrokerExecutedOnchainSimulationResult
  | BrokerRejectedExecutionResult
  | BrokerFailedExecutionResult;
