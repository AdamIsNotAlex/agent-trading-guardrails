import { randomUUID } from "node:crypto";
import type { EvmConfig, EvmSigner } from "./interfaces.js";

export class LocalDevSigner implements EvmSigner {
  constructor(
    private address: string,
    config: Pick<EvmConfig, "chainEnvironment">,
  ) {
    if (!config || config.chainEnvironment !== "sepolia") {
      throw new Error("LocalDevSigner can only be used for Sepolia.");
    }
  }

  async signAndBroadcast(_tx: { to: string; data?: string; value?: string }): Promise<string> {
    return `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  }

  getAddress(): string {
    return this.address;
  }
}
