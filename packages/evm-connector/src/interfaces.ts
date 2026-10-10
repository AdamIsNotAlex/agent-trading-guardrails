export interface EvmErc20TokenConfig {
  address: string;
  asset: string;
  balanceSlot: bigint | number | string;
  allowanceSlot?: bigint | number | string;
  totalSupplySlot?: bigint | number | string;
}

export interface EvmConfig {
  rpcUrl: string;
  chainId: number;
  chainEnvironment: "sepolia" | "mainnet";
  allowedContracts: string[];
  allowedFunctions: string[];
  allowedTokens: string[];
  allowedSpenders: string[];
  allowedRecipients?: string[];
  fromAddress?: string;
  observedAccounts?: string[];
  erc20Tokens?: EvmErc20TokenConfig[];
}

export interface DecodedTransaction {
  to: string;
  value: string;
  functionSelector: string | null;
  functionName: string | null;
  isApproval: boolean;
  approvalAmount: string | null;
  spender: string | null;
  recipient: string | null;
  token: string | null;
}

export interface SimulationResult {
  success: boolean;
  gasUsed: number;
  balanceChanges: Array<{ address: string; asset: string; delta: string }>;
  balanceChangesReliable: boolean;
  error: string | null;
}

export interface SimulateTransactionRequest {
  to: string;
  data?: string;
  value?: string;
  from?: string;
  observedAddresses?: string[];
}

export interface EvmRpcProvider {
  simulateTransaction(tx: SimulateTransactionRequest): Promise<SimulationResult>;
  getBalance(address: string): Promise<string>;
  getBlockNumber(): Promise<number>;
}

export interface EvmSigner {
  signAndBroadcast(tx: { to: string; data?: string; value?: string }): Promise<string>;
  getAddress(): string;
}
