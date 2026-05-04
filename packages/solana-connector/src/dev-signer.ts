import { randomUUID } from "node:crypto";
import type { ParsedInstruction, SolanaSigner } from "./interfaces.js";

export class LocalDevSolanaSigner implements SolanaSigner {
  constructor(private publicKey: string) {}

  async signAndBroadcast(_instructions: ParsedInstruction[]): Promise<string> {
    return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  }

  getPublicKey(): string {
    return this.publicKey;
  }
}
