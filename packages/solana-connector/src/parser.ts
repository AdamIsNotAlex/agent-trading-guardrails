import type { ParsedInstruction } from "./interfaces.js";

export function parseInstructions(raw: Array<Record<string, unknown>>): ParsedInstruction[] {
  return raw.map((ix) => ({
    programId: String(ix.programId ?? ""),
    type: ix.type != null ? String(ix.type) : null,
    data: ix,
  }));
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
