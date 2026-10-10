import { TradingIntent } from "@guardrails/schemas";
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializedEIP1559,
} from "viem";
import { z } from "zod";

const uint256Max = (1n << 256n) - 1n;
export const UnsignedDecimal = z
  .string()
  .refine(
    (value) => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) <= uint256Max,
    "Expected a canonical uint256 decimal.",
  );

export const SigningRequest = z
  .object({
    approval: z
      .object({
        intentId: z.string().uuid(),
        correlationId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        outcome: z.literal("allow"),
        intent: TradingIntent,
        decidedAt: z.string().datetime(),
        decisionToken: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    transaction: z
      .object({
        nonce: z.number().int().nonnegative().safe(),
        gas: UnsignedDecimal,
        maxFeePerGas: UnsignedDecimal,
        maxPriorityFeePerGas: UnsignedDecimal,
      })
      .strict(),
  })
  .strict();
export type SigningRequest = z.infer<typeof SigningRequest>;

export const OfflineSignature = z
  .object({
    mode: z.literal("offline-sepolia"),
    chainId: z.literal(11155111),
    intentId: z.string().uuid(),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    signedTransaction: z.string().regex(/^0x02[0-9a-f]+$/),
    transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  })
  .strict();
export type OfflineSignature = z.infer<typeof OfflineSignature>;

export async function verifyOfflineSignature(
  request: SigningRequest,
  result: OfflineSignature,
  expectedAddress = result.address,
): Promise<void> {
  const serializedTransaction = result.signedTransaction as TransactionSerializedEIP1559;
  const address = await recoverTransactionAddress({ serializedTransaction });
  const transaction = parseTransaction(serializedTransaction);
  const intent = request.approval.intent;
  if (
    intent.action !== "onchain.request_signature" ||
    intent.chain !== "ethereum" ||
    address !== expectedAddress ||
    address !== result.address ||
    keccak256(serializedTransaction) !== result.transactionHash ||
    result.intentId !== intent.intentId ||
    transaction.chainId !== 11155111 ||
    transaction.to?.toLowerCase() !== intent.to.toLowerCase() ||
    (transaction.data ?? "0x").toLowerCase() !== (intent.data ?? "0x").toLowerCase() ||
    (transaction.value ?? 0n) !== BigInt(intent.value ?? "0") ||
    transaction.nonce !== request.transaction.nonce ||
    transaction.gas !== BigInt(request.transaction.gas) ||
    transaction.maxFeePerGas !== BigInt(request.transaction.maxFeePerGas) ||
    transaction.maxPriorityFeePerGas !== BigInt(request.transaction.maxPriorityFeePerGas)
  ) {
    throw new Error("Signer returned a signature that does not match the authorized request.");
  }
}
