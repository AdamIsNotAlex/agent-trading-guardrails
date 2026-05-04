import type { ParsedInstruction, SolanaConfig } from "./interfaces.js";
import { getUniquePrograms, hasAuthorityChange } from "./parser.js";

export type ValidationResult = { valid: true } | { valid: false; reason: string };

export function validatePrograms(
  instructions: ParsedInstruction[],
  config: SolanaConfig,
): ValidationResult {
  const programs = getUniquePrograms(instructions);
  for (const program of programs) {
    if (!config.allowedPrograms.includes(program)) {
      return { valid: false, reason: `Program ${program} is not in the allowlist.` };
    }
  }
  return { valid: true };
}

export function validateAuthorityChange(instructions: ParsedInstruction[]): ValidationResult {
  if (hasAuthorityChange(instructions)) {
    return { valid: false, reason: "Authority changes are not permitted." };
  }
  return { valid: true };
}

export function validateTokenMints(
  instructions: ParsedInstruction[],
  config: SolanaConfig,
): ValidationResult {
  for (const ix of instructions) {
    const mint = ix.data.mint ?? ix.data.tokenMint;
    if (mint && !config.allowedTokenMints.includes(String(mint))) {
      return { valid: false, reason: `Token mint ${mint} is not in the allowlist.` };
    }
  }
  return { valid: true };
}

export function validateAccounts(
  instructions: ParsedInstruction[],
  config: SolanaConfig,
): ValidationResult {
  for (const ix of instructions) {
    const destination = ix.data.destination ?? ix.data.recipient;
    if (destination && !config.allowedAccounts.includes(String(destination))) {
      return { valid: false, reason: `Account ${destination} is not in the allowlist.` };
    }
  }
  return { valid: true };
}
