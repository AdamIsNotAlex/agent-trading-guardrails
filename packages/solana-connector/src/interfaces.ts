export interface SolanaConfig {
  rpcUrl: string;
  chainEnvironment: "devnet" | "mainnet";
  allowedPrograms: string[];
  allowedTokenMints: string[];
  allowedAccounts: string[];
}

export interface ParsedInstruction {
  programId: string;
  type: string | null;
  data: Record<string, unknown>;
}

export interface SolanaSimulationResult {
  success: boolean;
  logs: string[];
  balanceChanges: Array<{ account: string; asset: string; delta: string }>;
  balanceChangesReliable: boolean;
  error: string | null;
}

export interface SolanaRpcProvider {
  simulateTransaction(instructions: ParsedInstruction[]): Promise<SolanaSimulationResult>;
  getBalance(address: string): Promise<number>;
  getSlot(): Promise<number>;
}

export interface SolanaSigner {
  signAndBroadcast(instructions: ParsedInstruction[]): Promise<string>;
  getPublicKey(): string;
}
