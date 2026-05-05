import { ConnectorRevalidationError, type ExecutionConnector } from "@guardrails/broker";
import type { TradingIntent } from "@guardrails/schemas";
import { compareSolanaBalanceDeltas, type ExpectedSolanaBalanceDelta } from "./balance-delta.js";
import type {
  ParsedInstruction,
  SolanaConfig,
  SolanaRpcProvider,
  SolanaSigner,
  SolanaSimulationResult,
} from "./interfaces.js";
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
      return { passed: false, reason: "Unsupported Solana connector action." };
    }
    if (!("chain" in intent) || intent.chain !== "solana") {
      return { passed: false, reason: "Intent is not for Solana." };
    }
    if (
      !("chainEnvironment" in intent) ||
      intent.chainEnvironment !== this.config.chainEnvironment
    ) {
      return { passed: false, reason: "Intent Solana environment does not match connector." };
    }
    if (
      "instructions" in intent &&
      Array.isArray(intent.instructions) &&
      intent.instructions.length === 0
    ) {
      return { passed: false, reason: "Solana instructions cannot be empty." };
    }

    const rawInstructions =
      "instructions" in intent && intent.instructions
        ? intent.instructions
        : [{ programId: "programId" in intent ? intent.programId : intent.to }];

    let instructions: ParsedInstruction[];
    try {
      instructions = parseInstructions(rawInstructions as Array<Record<string, unknown>>);
    } catch (err) {
      return {
        passed: false,
        reason: err instanceof Error ? err.message : "Solana instructions are invalid.",
      };
    }

    const programCheck = validatePrograms(instructions, this.config);
    if (!programCheck.valid) return { passed: false, reason: programCheck.reason };

    const authorityCheck = validateAuthorityChange(instructions);
    if (!authorityCheck.valid) return { passed: false, reason: authorityCheck.reason };

    const tokenCheck = validateTokenMints(instructions, this.config);
    if (!tokenCheck.valid) return { passed: false, reason: tokenCheck.reason };

    const accountCheck = validateAccounts(instructions, this.config);
    if (!accountCheck.valid) return { passed: false, reason: accountCheck.reason };

    try {
      if (
        intent.action === "onchain.request_signature" &&
        this.expectedDeltas(intent).length === 0
      ) {
        return { passed: false, reason: "Solana expected balance deltas are required." };
      }
    } catch (err) {
      return {
        passed: false,
        reason: err instanceof Error ? err.message : "Solana expected balance deltas are invalid.",
      };
    }

    return { passed: true };
  }

  async execute(intent: TradingIntent): Promise<{ orderId?: string; transactionHash?: string }> {
    const validation = await this.revalidate(intent);
    if (!validation.passed) {
      throw new ConnectorRevalidationError(
        validation.reason ?? "Solana connector revalidation failed.",
      );
    }

    if (!("to" in intent)) return {};
    if (
      "instructions" in intent &&
      Array.isArray(intent.instructions) &&
      intent.instructions.length === 0
    ) {
      throw new ConnectorRevalidationError("Solana instructions cannot be empty.");
    }
    const rawInstructions =
      "instructions" in intent && intent.instructions
        ? intent.instructions
        : [{ programId: "programId" in intent ? intent.programId : intent.to }];

    const instructions = parseInstructions(rawInstructions as Array<Record<string, unknown>>);

    if (intent.action === "onchain.simulate_transaction") {
      this.expectedDeltas(intent);
      const result = await this.provider.simulateTransaction(instructions);
      if (!result.success) {
        throw new Error(`Simulation failed: ${result.error}`);
      }
      this.assertExpectedDeltas(result, intent);
      return {};
    }

    if (intent.action === "onchain.request_signature") {
      if (!this.signer) {
        throw new Error("Signer not configured.");
      }
      if (this.expectedDeltas(intent).length === 0) {
        throw new Error("Solana expected balance deltas are required.");
      }
      const result = await this.provider.simulateTransaction(instructions);
      if (!result.success) {
        throw new Error(`Simulation failed: ${result.error}`);
      }
      this.assertExpectedDeltas(result, intent);
      const txHash = await this.signer.signAndBroadcast(instructions);
      return { transactionHash: txHash };
    }

    return {};
  }

  private assertExpectedDeltas(result: SolanaSimulationResult, intent: TradingIntent): void {
    if (!this.hasExpectedDeltas(intent)) return;

    if (this.expectedDeltas(intent).length === 0) {
      throw new Error("Solana expected balance deltas are required.");
    }

    if (!result.balanceChangesReliable) {
      throw new Error(
        "Balance delta check failed: simulation provider did not return reliable balance changes.",
      );
    }

    const expectedDeltas = this.expectedDeltas(intent);
    const comparison = compareSolanaBalanceDeltas(result.balanceChanges, expectedDeltas);
    if (!comparison.passed) {
      throw new Error(
        `Balance delta check failed: ${comparison.reasons
          .map((reason) => `${reason.account} ${reason.asset}: ${reason.reason}`)
          .join("; ")}`,
      );
    }
  }

  private hasExpectedDeltas(intent: TradingIntent): boolean {
    return "expectedDeltas" in intent && intent.expectedDeltas !== undefined;
  }

  private expectedDeltas(intent: TradingIntent): ExpectedSolanaBalanceDelta[] {
    if (!("expectedDeltas" in intent) || intent.expectedDeltas === undefined) return [];
    const { expectedDeltas } = intent;
    if (!Array.isArray(expectedDeltas)) {
      throw new Error("Solana expected balance deltas must be an array.");
    }
    if (expectedDeltas.some((delta) => !isExpectedSolanaDelta(delta))) {
      throw new Error("Solana expected balance deltas must use account-based integer entries.");
    }
    return expectedDeltas as ExpectedSolanaBalanceDelta[];
  }
}

function isExpectedSolanaDelta(delta: unknown): delta is ExpectedSolanaBalanceDelta {
  if (!delta || typeof delta !== "object") return false;
  const fields = delta as Record<string, unknown>;
  return (
    hasExactKeys(fields, ["account", "asset", "minDelta", "maxDelta"]) &&
    typeof fields.account === "string" &&
    fields.account.length > 0 &&
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
