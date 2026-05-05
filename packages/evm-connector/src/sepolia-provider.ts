import { type Address, createPublicClient, type Hex, http } from "viem";
import { sepolia } from "viem/chains";
import type { EvmConfig, EvmRpcProvider, SimulationResult } from "./interfaces.js";

export type SepoliaRpcProviderConfig = Pick<EvmConfig, "rpcUrl">;

export class SepoliaRpcProvider implements EvmRpcProvider {
  private client;

  constructor(config: SepoliaRpcProviderConfig) {
    this.client = createPublicClient({
      chain: sepolia,
      transport: http(config.rpcUrl),
    });
  }

  async simulateTransaction(tx: {
    to: string;
    data?: string;
    value?: string;
  }): Promise<SimulationResult> {
    try {
      await this.assertSepoliaChain();
      await this.client.call({
        to: tx.to as Address,
        data: tx.data as Hex | undefined,
        value: tx.value ? BigInt(tx.value) : undefined,
      });
      return {
        success: true,
        gasUsed: 0,
        balanceChanges: [],
        balanceChangesReliable: false,
        error: null,
      };
    } catch (err) {
      return {
        success: false,
        gasUsed: 0,
        balanceChanges: [],
        balanceChangesReliable: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getBalance(address: string): Promise<string> {
    await this.assertSepoliaChain();
    const balance = await this.client.getBalance({ address: address as Address });
    return balance.toString();
  }

  async getBlockNumber(): Promise<number> {
    await this.assertSepoliaChain();
    const blockNumber = await this.client.getBlockNumber();
    return Number(blockNumber);
  }

  private async assertSepoliaChain(): Promise<void> {
    const chainId = await this.client.getChainId();
    if (chainId !== sepolia.id) {
      throw new Error(
        `Configured EVM RPC returned chain ID ${chainId}; expected Sepolia ${sepolia.id}.`,
      );
    }
  }
}
