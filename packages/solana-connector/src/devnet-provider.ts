import {
  type AccountMeta,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type {
  ParsedInstruction,
  SolanaConfig,
  SolanaRpcProvider,
  SolanaSimulationResult,
} from "./interfaces.js";

export interface DevnetSolanaRpcProviderConfig extends Pick<SolanaConfig, "rpcUrl"> {
  feePayer: string;
}

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export class DevnetSolanaRpcProvider implements SolanaRpcProvider {
  private connection: Connection;
  private feePayer: PublicKey;

  constructor(config: DevnetSolanaRpcProviderConfig) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.feePayer = new PublicKey(config.feePayer);
  }

  async simulateTransaction(instructions: ParsedInstruction[]): Promise<SolanaSimulationResult> {
    try {
      const transactionInstructions = instructions.map((instruction) =>
        this.toTransactionInstruction(instruction),
      );
      await this.assertDevnet();
      const { blockhash } = await this.connection.getLatestBlockhash();
      const message = new TransactionMessage({
        payerKey: this.feePayer,
        recentBlockhash: blockhash,
        instructions: transactionInstructions,
      }).compileToV0Message();
      const simulation = await this.connection.simulateTransaction(
        new VersionedTransaction(message),
        {
          replaceRecentBlockhash: true,
          sigVerify: false,
        },
      );

      return {
        success: simulation.value.err == null,
        logs: simulation.value.logs ?? [],
        balanceChanges: [],
        balanceChangesReliable: false,
        error: simulation.value.err ? JSON.stringify(simulation.value.err) : null,
      };
    } catch (err) {
      return {
        success: false,
        logs: [],
        balanceChanges: [],
        balanceChangesReliable: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getBalance(address: string): Promise<number> {
    await this.assertDevnet();
    return this.connection.getBalance(new PublicKey(address));
  }

  async getSlot(): Promise<number> {
    await this.assertDevnet();
    return this.connection.getSlot("confirmed");
  }

  private async assertDevnet(): Promise<void> {
    const genesisHash = await this.connection.getGenesisHash();
    if (genesisHash !== DEVNET_GENESIS_HASH) {
      throw new Error(
        `Configured Solana RPC returned genesis hash ${genesisHash}; expected devnet.`,
      );
    }
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
      if (typeof fields.pubkey !== "string") {
        throw new Error("Solana instruction account metadata is missing a pubkey.");
      }
      if (typeof fields.isSigner !== "boolean" || typeof fields.isWritable !== "boolean") {
        throw new Error("Solana instruction account metadata flags must be booleans.");
      }
      return {
        pubkey: new PublicKey(fields.pubkey),
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
