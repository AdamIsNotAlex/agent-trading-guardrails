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

export const BrokerExecutionResult = z
  .object({
    intentId: z.string().uuid(),
    idempotencyKey: z.string().min(1),
    status: BrokerExecutionStatus,
    orderId: z.string().optional(),
    transactionHash: z.string().optional(),
    orderStatus: BrokerOrderStatus.optional(),
    revalidationPassed: z.boolean(),
    rejectionReason: z.string().optional(),
    executedAt: z.string().datetime(),
  })
  .strict()
  .refine((data) => !(data.status === "executed" && !data.revalidationPassed), {
    message: "executed status requires revalidationPassed to be true",
  });
export type BrokerExecutionResult = z.infer<typeof BrokerExecutionResult>;
