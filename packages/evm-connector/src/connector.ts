import { ConnectorRevalidationError, type ExecutionConnector } from "@guardrails/broker";
import type { TradingIntent } from "@guardrails/schemas";
import { compareEvmBalanceDeltas, type ExpectedEvmBalanceDelta } from "./balance-delta.js";
import { decodeTransaction, isUnlimitedApproval } from "./decoder.js";
import type { EvmConfig, EvmRpcProvider, EvmSigner, SimulationResult } from "./interfaces.js";
import {
  validateContract,
  validateFunction,
  validateSpender,
  validateToken,
} from "./validation.js";

export class EvmConnector implements ExecutionConnector {
  constructor(
    private config: EvmConfig,
    private provider: EvmRpcProvider,
    private signer: EvmSigner | null,
  ) {}

  async revalidate(intent: TradingIntent): Promise<{ passed: boolean; reason?: string }> {
    if (
      intent.action !== "onchain.simulate_transaction" &&
      intent.action !== "onchain.request_signature"
    ) {
      return { passed: false, reason: "Unsupported Ethereum connector action." };
    }
    if (!("chain" in intent) || intent.chain !== "ethereum") {
      return { passed: false, reason: "Intent is not for Ethereum." };
    }
    if (
      !("chainEnvironment" in intent) ||
      intent.chainEnvironment !== this.config.chainEnvironment
    ) {
      return { passed: false, reason: "Intent Ethereum environment does not match connector." };
    }
    if (!("to" in intent)) {
      return { passed: false, reason: "Intent missing 'to' address." };
    }

    const decoded = decodeTransaction(
      intent.to,
      "data" in intent ? intent.data : undefined,
      "value" in intent ? intent.value : undefined,
    );

    if (isUnlimitedApproval(decoded)) {
      return { passed: false, reason: "Unlimited token approvals are not permitted." };
    }

    const contractCheck = validateContract(decoded, this.config);
    if (!contractCheck.valid) return { passed: false, reason: contractCheck.reason };

    const functionCheck = validateFunction(
      decoded,
      this.config,
      intent.action === "onchain.request_signature",
    );
    if (!functionCheck.valid) return { passed: false, reason: functionCheck.reason };

    const tokenCheck = validateToken(decoded, this.config);
    if (!tokenCheck.valid) return { passed: false, reason: tokenCheck.reason };

    const spenderCheck = validateSpender(decoded, this.config);
    if (!spenderCheck.valid) return { passed: false, reason: spenderCheck.reason };

    try {
      if (
        intent.action === "onchain.request_signature" &&
        this.expectedDeltas(intent).length === 0
      ) {
        return { passed: false, reason: "Ethereum expected balance deltas are required." };
      }
      this.expectedDeltas(intent);
    } catch (err) {
      return {
        passed: false,
        reason:
          err instanceof Error ? err.message : "Ethereum expected balance deltas are invalid.",
      };
    }

    const recipientCheck = this.validateRecipient(decoded.recipient, intent);
    if (!recipientCheck.valid) return { passed: false, reason: recipientCheck.reason };

    const approvalCheck = this.validateApprovalAmount(decoded.approvalAmount, intent);
    if (!approvalCheck.valid) return { passed: false, reason: approvalCheck.reason };

    return { passed: true };
  }

  async execute(intent: TradingIntent): Promise<{ orderId?: string; transactionHash?: string }> {
    const validation = await this.revalidate(intent);
    if (!validation.passed) {
      throw new ConnectorRevalidationError(
        validation.reason ?? "Ethereum connector revalidation failed.",
      );
    }

    if (intent.action === "onchain.simulate_transaction" && "to" in intent) {
      this.expectedDeltas(intent);
      const result = await this.provider.simulateTransaction({
        to: intent.to,
        data: "data" in intent ? intent.data : undefined,
        value: "value" in intent ? intent.value : undefined,
      });
      if (!result.success) {
        throw new Error(`Simulation failed: ${result.error}`);
      }
      this.assertExpectedDeltas(result, intent);
      return {};
    }

    if (intent.action === "onchain.request_signature" && "to" in intent) {
      if (!this.signer) {
        throw new Error("Signer not configured.");
      }
      if (this.expectedDeltas(intent).length === 0) {
        throw new Error("Ethereum expected balance deltas are required.");
      }
      const result = await this.provider.simulateTransaction({
        to: intent.to,
        data: "data" in intent ? intent.data : undefined,
        value: "value" in intent ? intent.value : undefined,
      });
      if (!result.success) {
        throw new Error(`Simulation failed: ${result.error}`);
      }
      this.assertExpectedDeltas(result, intent);
      const txHash = await this.signer.signAndBroadcast({
        to: intent.to,
        data: "data" in intent ? intent.data : undefined,
        value: "value" in intent ? intent.value : undefined,
      });
      return { transactionHash: txHash };
    }

    return {};
  }

  private validateRecipient(
    recipient: string | null,
    intent: TradingIntent,
  ): { valid: true } | { valid: false; reason: string } {
    if (!recipient) return { valid: true };
    if (!("expectedDeltas" in intent) || intent.expectedDeltas === undefined) {
      return { valid: false, reason: "ERC-20 transfer recipient requires expected deltas." };
    }
    const normalizedRecipient = recipient.toLowerCase();
    const recipientAllowed = this.config.allowedRecipients?.some(
      (allowedRecipient) => allowedRecipient.toLowerCase() === normalizedRecipient,
    );
    if (!recipientAllowed) {
      return { valid: false, reason: `Transfer recipient ${recipient} is not in the allowlist.` };
    }
    const coveredByDeltas = this.expectedDeltas(intent).some(
      (delta) => delta.address.toLowerCase() === normalizedRecipient,
    );
    if (!coveredByDeltas) {
      return {
        valid: false,
        reason: `Transfer recipient ${recipient} is not covered by expected deltas.`,
      };
    }
    return { valid: true };
  }

  private validateApprovalAmount(
    approvalAmount: string | null,
    intent: TradingIntent,
  ): { valid: true } | { valid: false; reason: string } {
    if (!approvalAmount) return { valid: true };
    if (!("maxTokenApprovalAmount" in intent) || intent.maxTokenApprovalAmount === undefined) {
      return { valid: false, reason: "ERC-20 approvals require maxTokenApprovalAmount." };
    }
    let amount: bigint;
    let maxAmount: bigint;
    try {
      amount = BigInt(approvalAmount);
      maxAmount = BigInt(intent.maxTokenApprovalAmount);
    } catch {
      return { valid: false, reason: "Approval amount must be an integer." };
    }
    if (amount > maxAmount) {
      return { valid: false, reason: "Approval amount exceeds maxTokenApprovalAmount." };
    }
    return { valid: true };
  }

  private assertExpectedDeltas(result: SimulationResult, intent: TradingIntent): void {
    if (!this.hasExpectedDeltas(intent)) return;

    if (!result.balanceChangesReliable) {
      throw new Error(
        "Balance delta check failed: simulation provider did not return reliable balance changes.",
      );
    }

    const expectedDeltas = this.expectedDeltas(intent);
    const comparison = compareEvmBalanceDeltas(result.balanceChanges, expectedDeltas);
    if (!comparison.passed) {
      throw new Error(
        `Balance delta check failed: ${comparison.reasons
          .map((reason) => `${reason.address} ${reason.asset}: ${reason.reason}`)
          .join("; ")}`,
      );
    }
  }

  private hasExpectedDeltas(intent: TradingIntent): boolean {
    return "expectedDeltas" in intent && intent.expectedDeltas !== undefined;
  }

  private expectedDeltas(intent: TradingIntent): ExpectedEvmBalanceDelta[] {
    if (!("expectedDeltas" in intent) || intent.expectedDeltas === undefined) return [];
    const { expectedDeltas } = intent;
    if (!Array.isArray(expectedDeltas)) {
      throw new Error("Ethereum expected balance deltas must be an array.");
    }
    if (expectedDeltas.some((delta) => !isExpectedEvmDelta(delta))) {
      throw new Error("Ethereum expected balance deltas must use address-based integer entries.");
    }
    return expectedDeltas as ExpectedEvmBalanceDelta[];
  }
}

function isExpectedEvmDelta(delta: unknown): delta is ExpectedEvmBalanceDelta {
  if (!delta || typeof delta !== "object") return false;
  const fields = delta as Record<string, unknown>;
  return (
    hasExactKeys(fields, ["address", "asset", "minDelta", "maxDelta"]) &&
    typeof fields.address === "string" &&
    fields.address.length > 0 &&
    typeof fields.asset === "string" &&
    fields.asset.length > 0 &&
    typeof fields.minDelta === "string" &&
    typeof fields.maxDelta === "string" &&
    /^-?\d+$/.test(fields.minDelta) &&
    /^-?\d+$/.test(fields.maxDelta)
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
