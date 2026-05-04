export interface SecretProvider {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface SignerBackend {
  sign(payload: Uint8Array): Promise<Uint8Array>;
  getPublicKey(): string;
  getAddress(): string;
}

export type Environment = "dev" | "paper" | "testnet" | "canary_live" | "production";
