import { PublicKey } from "@solana/web3.js";
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./account-state.js";
import type { ParsedInstruction } from "./interfaces.js";

export function parseInstructions(raw: Array<Record<string, unknown>>): ParsedInstruction[] {
  return raw.map((instruction) => {
    const programId = String(instruction.programId ?? "");
    if (instruction.data == null) {
      return {
        programId,
        type: instruction.type != null ? String(instruction.type) : null,
        data: instruction,
      };
    }
    if (instruction.type != null) {
      throw new Error("Solana raw instruction data cannot rely on caller-supplied type.");
    }
    const bytes = decodeInstructionData(instruction.data);
    const keys = instruction.keys;
    if (!Array.isArray(keys)) throw unsupported();
    const accounts = keys.map((key: unknown) => {
      if (!key || typeof key !== "object") throw unsupported();
      const fields = key as Record<string, unknown>;
      if (
        typeof fields.pubkey !== "string" ||
        typeof fields.isSigner !== "boolean" ||
        typeof fields.isWritable !== "boolean"
      )
        throw unsupported();
      return {
        pubkey: new PublicKey(fields.pubkey).toBase58(),
        isSigner: fields.isSigner,
        isWritable: fields.isWritable,
      };
    });
    const data: Record<string, unknown> = { ...instruction, keys: accounts };
    if (
      programId === SYSTEM_PROGRAM_ID &&
      bytes.length === 12 &&
      bytes.readUInt32LE(0) === 2 &&
      accounts.length === 2 &&
      accounts[0].isSigner &&
      accounts[0].isWritable &&
      accounts[1].isWritable
    ) {
      data.source = accounts[0].pubkey;
      data.destination = accounts[1].pubkey;
      data.amount = bytes.readBigUInt64LE(4).toString();
      return { programId, type: "transfer", data };
    }
    if (
      (programId === TOKEN_PROGRAM_ID || programId === TOKEN_2022_PROGRAM_ID) &&
      bytes.length === 10 &&
      bytes[0] === 12 &&
      accounts.length >= 4 &&
      accounts[0].isWritable &&
      accounts[2].isWritable
    ) {
      data.source = accounts[0].pubkey;
      data.mint = accounts[1].pubkey;
      data.tokenMint = accounts[1].pubkey;
      data.destination = accounts[2].pubkey;
      data.owner = accounts[3].pubkey;
      data.amount = bytes.readBigUInt64LE(1).toString();
      data.decimals = bytes[9];
      return { programId, type: "transferChecked", data };
    }
    // In particular, SetAuthority and unchecked transfers cannot hide behind caller metadata.
    throw unsupported();
  });
}

function unsupported(): Error {
  return new Error("Solana raw instruction data is unsupported without trusted decoding.");
}

function decodeInstructionData(value: unknown): Buffer {
  if (typeof value !== "string") throw unsupported();
  if (value.startsWith("0x")) {
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw unsupported();
    return Buffer.from(value.slice(2), "hex");
  }
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value) throw unsupported();
  return data;
}

export function hasAuthorityChange(instructions: ParsedInstruction[]): boolean {
  return instructions.some(
    (ix) =>
      ix.type === "authority_change" || ix.type === "setAuthority" || ix.type === "SetAuthority",
  );
}

export function getUniquePrograms(instructions: ParsedInstruction[]): string[] {
  return [...new Set(instructions.map((ix) => ix.programId))];
}
