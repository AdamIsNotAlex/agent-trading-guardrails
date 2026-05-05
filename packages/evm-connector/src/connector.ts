import type { ExecutionConnector } from "@guardrails/broker";
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
      return { passed: true };
    }
    if (!("chain" in intent) || intent.chain !== "ethereum") {
      return { passed: false, reason: "Intent is not for Ethereum." };
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

    const functionCheck = validateFunction(decoded, this.config);
    if (!functionCheck.valid) return { passed: false, reason: functionCheck.reason };

    const tokenCheck = validateToken(decoded, this.config);
    if (!tokenCheck.valid) return { passed: false, reason: tokenCheck.reason };

    const spenderCheck = validateSpender(decoded, this.config);
    if (!spenderCheck.valid) return { passed: false, reason: spenderCheck.reason };

    return { passed: true };
  }

  async execute(intent: TradingIntent): Promise<{ orderId?: string; transactionHash?: string }> {
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
      if (this.hasExpectedDeltas(intent)) {
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
      }
      const txHash = await this.signer.signAndBroadcast({
        to: intent.to,
        data: "data" in intent ? intent.data : undefined,
        value: "value" in intent ? intent.value : undefined,
      });
      return { transactionHash: txHash };
    }

    return {};
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
