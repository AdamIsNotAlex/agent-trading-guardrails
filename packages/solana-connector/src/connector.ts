import type { ExecutionConnector } from "@guardrails/broker";
import type { TradingIntent } from "@guardrails/schemas";
import type { SolanaConfig, SolanaRpcProvider, SolanaSigner } from "./interfaces.js";
import { parseInstructions } from "./parser.js";
import {
  validateAccounts,
  validateAuthorityChange,
  validatePrograms,
  validateTokenMints,
} from "./validation.js";

export class SolanaConnector implements ExecutionConnector {
  constructor(
    private config: SolanaConfig,
    private provider: SolanaRpcProvider,
    private signer: SolanaSigner | null,
  ) {}

  async revalidate(intent: TradingIntent): Promise<{ passed: boolean; reason?: string }> {
    if (
      intent.action !== "onchain.simulate_transaction" &&
      intent.action !== "onchain.request_signature"
    ) {
      return { passed: true };
    }
    if (!("chain" in intent) || intent.chain !== "solana") {
      return { passed: false, reason: "Intent is not for Solana." };
    }

    const rawInstructions =
      "instructions" in intent && intent.instructions
        ? intent.instructions
        : [{ programId: "programId" in intent ? intent.programId : intent.to }];

    const instructions = parseInstructions(rawInstructions as Array<Record<string, unknown>>);

    const programCheck = validatePrograms(instructions, this.config);
    if (!programCheck.valid) return { passed: false, reason: programCheck.reason };

    const authorityCheck = validateAuthorityChange(instructions);
    if (!authorityCheck.valid) return { passed: false, reason: authorityCheck.reason };

    const tokenCheck = validateTokenMints(instructions, this.config);
    if (!tokenCheck.valid) return { passed: false, reason: tokenCheck.reason };

    const accountCheck = validateAccounts(instructions, this.config);
    if (!accountCheck.valid) return { passed: false, reason: accountCheck.reason };

    return { passed: true };
  }

  async execute(intent: TradingIntent): Promise<{ orderId?: string; transactionHash?: string }> {
    if (!("to" in intent)) return {};
    const rawInstructions =
      "instructions" in intent && intent.instructions
        ? intent.instructions
        : [{ programId: "programId" in intent ? intent.programId : intent.to }];

    const instructions = parseInstructions(rawInstructions as Array<Record<string, unknown>>);

    if (intent.action === "onchain.simulate_transaction") {
      const result = await this.provider.simulateTransaction(instructions);
      if (!result.success) {
        throw new Error(`Simulation failed: ${result.error}`);
      }
      return {};
    }

    if (intent.action === "onchain.request_signature") {
      if (!this.signer) {
        throw new Error("Signer not configured.");
      }
      const result = await this.provider.simulateTransaction(instructions);
      if (!result.success) {
        throw new Error(`Simulation failed: ${result.error}`);
      }
      const txHash = await this.signer.signAndBroadcast(instructions);
      return { transactionHash: txHash };
    }

    return {};
  }
}
