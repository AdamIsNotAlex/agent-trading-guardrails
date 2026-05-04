import { z } from "zod";

export const BrokerExecutionStatus = z.enum(["executed", "rejected", "failed"]);
export type BrokerExecutionStatus = z.infer<typeof BrokerExecutionStatus>;

export const BrokerExecutionResult = z
  .object({
    intentId: z.string().uuid(),
    idempotencyKey: z.string().min(1),
    status: BrokerExecutionStatus,
    orderId: z.string().optional(),
    transactionHash: z.string().optional(),
    revalidationPassed: z.boolean(),
    rejectionReason: z.string().optional(),
    executedAt: z.string().datetime(),
  })
  .strict()
  .refine((data) => !(data.status === "executed" && !data.revalidationPassed), {
    message: "executed status requires revalidationPassed to be true",
  });
export type BrokerExecutionResult = z.infer<typeof BrokerExecutionResult>;
