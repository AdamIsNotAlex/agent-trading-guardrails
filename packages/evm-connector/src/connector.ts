import type { ExecutionConnector } from "@guardrails/broker";
import type { TradingIntent } from "@guardrails/schemas";
import { decodeTransaction, isUnlimitedApproval } from "./decoder.js";
import type { EvmConfig, EvmRpcProvider, EvmSigner } from "./interfaces.js";
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
      const result = await this.provider.simulateTransaction({
        to: intent.to,
        data: "data" in intent ? intent.data : undefined,
        value: "value" in intent ? intent.value : undefined,
      });
      if (!result.success) {
        throw new Error(`Simulation failed: ${result.error}`);
      }
      return {};
    }

    if (intent.action === "onchain.request_signature" && "to" in intent) {
      if (!this.signer) {
        throw new Error("Signer not configured.");
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
}
