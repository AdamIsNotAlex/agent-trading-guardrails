import { Keypair, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { parseInstructions } from "./parser.js";

const source = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey;
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
const ix = SystemProgram.transfer({ fromPubkey: source, toPubkey: recipient, lamports: 100 });
const raw = {
  programId: ix.programId.toBase58(),
  data: ix.data.toString("base64"),
  keys: ix.keys.map((key) => ({ ...key, pubkey: key.pubkey.toBase58() })),
};

describe("trusted Solana instruction decoding", () => {
  it("derives destinations from bytes and account keys, not caller labels", () => {
    const [decoded] = parseInstructions([{ ...raw, destination: source.toBase58() }]);
    expect(decoded.data.destination).toBe(recipient.toBase58());
    expect(decoded.data.source).toBe(source.toBase58());
    expect(decoded.data.amount).toBe("100");
  });
  it.each([
    0, 1, 8, 11,
  ])("rejects unsupported System opcode %i instead of treating it as a transfer", (opcode) => {
    const data = Buffer.from(ix.data);
    data.writeUInt32LE(opcode);
    expect(() => parseInstructions([{ ...raw, data: data.toString("base64") }])).toThrow();
  });
  it("rejects trailing instructions, invalid metadata, and spoofed instruction types", () => {
    expect(() =>
      parseInstructions([
        { ...raw, data: Buffer.concat([ix.data, Buffer.of(1)]).toString("base64") },
      ]),
    ).toThrow();
    expect(() => parseInstructions([{ ...raw, keys: [{ pubkey: source.toBase58() }] }])).toThrow();
    expect(() => parseInstructions([{ ...raw, type: "setAuthority" }])).toThrow();
    expect(() => parseInstructions([{ ...raw, programId: "constructor" }])).toThrow();
  });
});
