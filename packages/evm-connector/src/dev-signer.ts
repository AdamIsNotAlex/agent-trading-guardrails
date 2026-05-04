import { randomUUID } from "node:crypto";
import type { EvmSigner } from "./interfaces.js";

export class LocalDevSigner implements EvmSigner {
  constructor(private address: string) {}

  async signAndBroadcast(_tx: { to: string; data?: string; value?: string }): Promise<string> {
    return `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  }

  getAddress(): string {
    return this.address;
  }
}
