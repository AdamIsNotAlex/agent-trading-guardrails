export interface EvmConfig {
  rpcUrl: string;
  chainId: number;
  chainEnvironment: "sepolia" | "mainnet";
  allowedContracts: string[];
  allowedFunctions: string[];
  allowedTokens: string[];
  allowedSpenders: string[];
}

export interface DecodedTransaction {
  to: string;
  value: string;
  functionSelector: string | null;
  functionName: string | null;
  isApproval: boolean;
  approvalAmount: string | null;
  spender: string | null;
  token: string | null;
}

export interface SimulationResult {
  success: boolean;
  gasUsed: number;
  balanceChanges: Array<{ address: string; asset: string; delta: string }>;
  balanceChangesReliable: boolean;
  error: string | null;
}

export interface EvmRpcProvider {
  simulateTransaction(tx: { to: string; data?: string; value?: string }): Promise<SimulationResult>;
  getBalance(address: string): Promise<string>;
  getBlockNumber(): Promise<number>;
}

export interface EvmSigner {
  signAndBroadcast(tx: { to: string; data?: string; value?: string }): Promise<string>;
  getAddress(): string;
}
