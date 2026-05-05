import type { ParsedInstruction } from "./interfaces.js";

export function parseInstructions(raw: Array<Record<string, unknown>>): ParsedInstruction[] {
  return raw.map((ix) => {
    if (ix.data != null && ix.type != null) {
      throw new Error("Solana raw instruction data cannot rely on caller-supplied type.");
    }
    return {
      programId: String(ix.programId ?? ""),
      type: ix.type != null ? String(ix.type) : null,
      data: ix,
    };
  });
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
