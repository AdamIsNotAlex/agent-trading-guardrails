import type { DecodedTransaction, EvmConfig } from "./interfaces.js";

export type ValidationResult = { valid: true } | { valid: false; reason: string };

export function validateContract(decoded: DecodedTransaction, config: EvmConfig): ValidationResult {
  const normalizedTo = decoded.to.toLowerCase();
  const allowed = config.allowedContracts.some((c) => c.toLowerCase() === normalizedTo);
  if (!allowed) {
    return { valid: false, reason: `Contract ${decoded.to} is not in the allowlist.` };
  }
  return { valid: true };
}

export function validateFunction(
  decoded: DecodedTransaction,
  config: EvmConfig,
  requireFunction = false,
): ValidationResult {
  if (!decoded.functionSelector) {
    return requireFunction
      ? { valid: false, reason: "Ethereum signing requires calldata for an allowed function." }
      : { valid: true };
  }
  if (!decoded.functionName) {
    return { valid: false, reason: `Function ${decoded.functionSelector} calldata is malformed.` };
  }
  if (config.allowedFunctions.includes(decoded.functionName)) {
    return { valid: true };
  }
  if (config.allowedFunctions.includes(decoded.functionSelector)) {
    return { valid: true };
  }
  return { valid: false, reason: `Function ${decoded.functionSelector} is not in the allowlist.` };
}

export function validateToken(decoded: DecodedTransaction, config: EvmConfig): ValidationResult {
  if (!decoded.token) return { valid: true };
  const normalizedToken = decoded.token.toLowerCase();
  const allowed = config.allowedTokens.some((t) => t.toLowerCase() === normalizedToken);
  if (!allowed) {
    return { valid: false, reason: `Token ${decoded.token} is not in the allowlist.` };
  }
  return { valid: true };
}

export function validateSpender(decoded: DecodedTransaction, config: EvmConfig): ValidationResult {
  if (!decoded.spender) return { valid: true };
  const normalizedSpender = decoded.spender.toLowerCase();
  const allowed = config.allowedSpenders.some((s) => s.toLowerCase() === normalizedSpender);
  if (!allowed) {
    return { valid: false, reason: `Spender ${decoded.spender} is not in the allowlist.` };
  }
  return { valid: true };
}
