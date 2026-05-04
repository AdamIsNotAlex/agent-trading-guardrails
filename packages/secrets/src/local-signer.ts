import { createHash, randomBytes } from "node:crypto";
import type { SignerBackend } from "./interfaces.js";

export class LocalTestnetSigner implements SignerBackend {
  #keyMaterial: Buffer;
  #pubKey: string;
  #addr: string;

  constructor() {
    this.#keyMaterial = randomBytes(32);
    this.#pubKey = createHash("sha256").update(this.#keyMaterial).digest("hex");
    this.#addr = `0x${this.#pubKey.slice(0, 40)}`;
  }

  async sign(payload: Uint8Array): Promise<Uint8Array> {
    const hash = createHash("sha256").update(this.#keyMaterial).update(payload).digest();
    return new Uint8Array(hash);
  }

  getPublicKey(): string {
    return this.#pubKey;
  }

  getAddress(): string {
    return this.#addr;
  }

  toJSON(): Record<string, string> {
    return { publicKey: this.#pubKey, address: this.#addr };
  }
}
