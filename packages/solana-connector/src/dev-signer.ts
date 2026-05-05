import { randomUUID } from "node:crypto";
import type { ParsedInstruction, SolanaConfig, SolanaSigner } from "./interfaces.js";

export class LocalDevSolanaSigner implements SolanaSigner {
  constructor(
    private publicKey: string,
    config: Pick<SolanaConfig, "chainEnvironment">,
  ) {
    if (!config || config.chainEnvironment !== "devnet") {
      throw new Error("LocalDevSolanaSigner can only be used for devnet.");
    }
  }

  async signAndBroadcast(_instructions: ParsedInstruction[]): Promise<string> {
    return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  }

  getPublicKey(): string {
    return this.publicKey;
  }
}
