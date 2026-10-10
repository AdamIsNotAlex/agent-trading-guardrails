import {
  type AccountMeta,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  diffObservedBalances,
  MAX_OBSERVATION_ACCOUNTS,
  pubkeyOf,
  type ResolvedSnapshot,
  SYSTEM_PROGRAM_ID,
  snapshotFromPost,
  snapshotFromPre,
} from "./account-state.js";
import type {
  ParsedInstruction,
  SolanaConfig,
  SolanaRpcProvider,
  SolanaSimulateTransactionOptions,
  SolanaSimulationResult,
} from "./interfaces.js";

export interface DevnetSolanaRpcProviderConfig extends Pick<SolanaConfig, "rpcUrl"> {
  feePayer?: string;
}

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const FINALIZED = "finalized" as const;
const DUMMY_BLOCKHASH = SYSTEM_PROGRAM_ID;

export class DevnetSolanaRpcProvider implements SolanaRpcProvider {
  private connection: Connection;
  private feePayer: PublicKey | null;

  constructor(config: DevnetSolanaRpcProviderConfig) {
    this.connection = new Connection(config.rpcUrl, FINALIZED);
    this.feePayer = config.feePayer === undefined ? null : new PublicKey(config.feePayer);
  }

  async simulateTransaction(
    instructions: ParsedInstruction[],
    options?: SolanaSimulateTransactionOptions,
  ): Promise<SolanaSimulationResult> {
    try {
      const feePayer = this.resolveFeePayer(options);
      const transactionInstructions = instructions.map((instruction) =>
        this.toTransactionInstruction(instruction),
      );
      const message = new TransactionMessage({
        payerKey: feePayer,
        recentBlockhash: DUMMY_BLOCKHASH,
        instructions: transactionInstructions,
      }).compileToV0Message();
      const observationAddresses = message.staticAccountKeys.map((key) => key.toBase58());
      if (observationAddresses.length > MAX_OBSERVATION_ACCOUNTS) {
        return failClosed(
          `Simulation observes ${observationAddresses.length} accounts; maximum is ${MAX_OBSERVATION_ACCOUNTS}.`,
        );
      }

      await this.assertDevnet();

      const pre = await this.connection.getMultipleAccountsInfoAndContext(
        observationAddresses.map((address) => new PublicKey(address)),
        { commitment: FINALIZED },
      );
      if (!Array.isArray(pre.value) || pre.value.length !== observationAddresses.length) {
        return failClosed("Pre-account snapshot is truncated or missing.");
      }

      const snapshotSlot = pre.context.slot;
      if (!Number.isSafeInteger(snapshotSlot) || snapshotSlot < 0) {
        return failClosed("Account snapshot slot is invalid.");
      }
      const latest = await this.connection.getLatestBlockhashAndContext({
        commitment: FINALIZED,
        minContextSlot: snapshotSlot,
      });
      message.recentBlockhash = latest.value.blockhash;
      const simulation = await this.connection.simulateTransaction(
        new VersionedTransaction(message),
        {
          commitment: FINALIZED,
          replaceRecentBlockhash: true,
          sigVerify: false,
          minContextSlot: snapshotSlot,
          accounts: {
            encoding: "base64",
            addresses: observationAddresses,
          },
        },
      );

      const success = simulation.value.err == null;
      const logs = simulation.value.logs ?? [];
      const error = simulation.value.err ? JSON.stringify(simulation.value.err) : null;
      if (!success) {
        return { success: false, logs, balanceChanges: [], balanceChangesReliable: false, error };
      }

      if (simulation.context.slot !== snapshotSlot) {
        return {
          success: true,
          logs,
          balanceChanges: [],
          balanceChangesReliable: false,
          error: `Simulation context slot ${simulation.context.slot} does not match snapshot slot ${snapshotSlot}.`,
        };
      }

      const postAccounts = simulation.value.accounts;
      if (!Array.isArray(postAccounts) || postAccounts.length !== observationAddresses.length) {
        return {
          success: true,
          logs,
          balanceChanges: [],
          balanceChangesReliable: false,
          error: "Simulation account snapshot is truncated or missing.",
        };
      }

      const preSnapshots = new Map<string, ResolvedSnapshot>();
      const postSnapshots = new Map<string, ResolvedSnapshot>();
      for (let index = 0; index < observationAddresses.length; index += 1) {
        const address = observationAddresses[index];
        preSnapshots.set(address, snapshotFromPre(pre.value[index]));
        postSnapshots.set(address, snapshotFromPost(postAccounts[index]));
      }

      return {
        success: true,
        logs,
        balanceChanges: diffObservedBalances(observationAddresses, preSnapshots, postSnapshots),
        balanceChangesReliable: true,
        error: null,
      };
    } catch (err) {
      return failClosed(err instanceof Error ? err.message : String(err));
    }
  }

  async getBalance(address: string): Promise<number> {
    await this.assertDevnet();
    return this.connection.getBalance(new PublicKey(address), FINALIZED);
  }

  async getSlot(): Promise<number> {
    await this.assertDevnet();
    return this.connection.getSlot(FINALIZED);
  }

  private async assertDevnet(): Promise<void> {
    const genesisHash = await this.connection.getGenesisHash();
    if (genesisHash !== DEVNET_GENESIS_HASH) {
      throw new Error(
        `Configured Solana RPC returned genesis hash ${genesisHash}; expected devnet.`,
      );
    }
  }

  private resolveFeePayer(options?: SolanaSimulateTransactionOptions): PublicKey {
    const requested = options?.feePayer;
    if (requested !== undefined) {
      if (typeof requested !== "string" || requested.length === 0) {
        throw new Error("Simulation fee payer must be a non-empty public key.");
      }
      const payer = new PublicKey(requested);
      if (this.feePayer && !this.feePayer.equals(payer)) {
        throw new Error("Simulation fee payer does not match the configured provider fee payer.");
      }
      return payer;
    }
    if (!this.feePayer) {
      throw new Error("Simulation fee payer is required.");
    }
    return this.feePayer;
  }

  private toTransactionInstruction(instruction: ParsedInstruction): TransactionInstruction {
    return new TransactionInstruction({
      programId: new PublicKey(instruction.programId),
      keys: this.toAccountMetas(instruction.data.keys),
      data: this.toInstructionData(instruction.data.data, Object.hasOwn(instruction.data, "data")),
    });
  }

  private toAccountMetas(value: unknown): AccountMeta[] {
    if (value === undefined) return [];
    if (value === null) throw new Error("Solana instruction keys must be an array.");
    if (!Array.isArray(value)) throw new Error("Solana instruction keys must be an array.");
    return value.map((account) => {
      if (!account || typeof account !== "object") {
        throw new Error("Solana instruction account metadata must be an object.");
      }
      const fields = account as Record<string, unknown>;
      const pubkey = pubkeyOf(fields.pubkey ?? account);
      if (!pubkey) {
        throw new Error("Solana instruction account metadata is missing a pubkey.");
      }
      if (typeof fields.isSigner !== "boolean" || typeof fields.isWritable !== "boolean") {
        throw new Error("Solana instruction account metadata flags must be booleans.");
      }
      return {
        pubkey: new PublicKey(pubkey),
        isSigner: fields.isSigner,
        isWritable: fields.isWritable,
      };
    });
  }

  private toInstructionData(value: unknown, hasData: boolean): Buffer {
    if (!hasData || value === "") return Buffer.alloc(0);
    if (typeof value !== "string") throw new Error("Solana instruction data must be a string.");
    if (value.startsWith("0x")) {
      const hex = value.slice(2);
      if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
        throw new Error("Solana instruction data is not valid hex.");
      }
      return Buffer.from(hex, "hex");
    }
    if (!/^[0-9a-zA-Z+/]*={0,2}$/.test(value)) {
      throw new Error("Solana instruction data is not valid base64.");
    }
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
      throw new Error("Solana instruction data is not valid base64.");
    }
    return decoded;
  }
}

function failClosed(error: string): SolanaSimulationResult {
  return {
    success: false,
    logs: [],
    balanceChanges: [],
    balanceChangesReliable: false,
    error,
  };
}
