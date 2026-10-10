import { isIP } from "node:net";
import type { TradingIntent } from "@guardrails/schemas";
import type { BinanceApiKeyPermissions, BinanceConfig } from "./interfaces.js";

export type ValidationResult = { valid: true } | { valid: false; reason: string };

export function validateIntent(intent: TradingIntent, config: BinanceConfig): ValidationResult {
  if (!("exchange" in intent) || intent.exchange !== "binance") {
    return { valid: false, reason: "Intent is not for Binance." };
  }

  if (!("account" in intent)) {
    return { valid: false, reason: "Intent missing account." };
  }

  if (!config.allowedAccounts.includes(intent.account)) {
    return { valid: false, reason: `Account ${intent.account} is not in the allowlist.` };
  }

  if ("accountMode" in intent) {
    if (intent.accountMode === "spot") {
      if ("symbol" in intent && !config.allowedSpotSymbols.includes(intent.symbol)) {
        return { valid: false, reason: `Spot symbol ${intent.symbol} is not in the allowlist.` };
      }
    } else if (intent.accountMode === "usdm_futures") {
      if (!("marginType" in intent) || intent.marginType !== "isolated") {
        return { valid: false, reason: "USD-M futures orders must use isolated margin." };
      }
      if ("symbol" in intent && !config.allowedFuturesSymbols.includes(intent.symbol)) {
        return { valid: false, reason: `Futures symbol ${intent.symbol} is not in the allowlist.` };
      }
      if (
        "leverage" in intent &&
        intent.leverage != null &&
        intent.leverage > config.maxFuturesLeverage
      ) {
        return {
          valid: false,
          reason: `Leverage ${intent.leverage}x exceeds max ${config.maxFuturesLeverage}x.`,
        };
      }
    }
  } else if (
    "symbol" in intent &&
    !config.allowedSpotSymbols.includes(intent.symbol) &&
    !config.allowedFuturesSymbols.includes(intent.symbol)
  ) {
    return { valid: false, reason: `Symbol ${intent.symbol} is not in the allowlist.` };
  }

  return { valid: true };
}

export function rejectMarginModes(intent: TradingIntent): ValidationResult {
  if ("accountMode" in intent) {
    const mode = (intent as { accountMode: string }).accountMode;
    if (mode === "margin" || mode === "cross_margin") {
      return { valid: false, reason: "Spot margin and cross-margin are not supported." };
    }
    if (mode === "coinm_futures") {
      return { valid: false, reason: "COIN-M futures are not supported." };
    }
  }
  return { valid: true };
}

const WILDCARD_IPS: Record<string, true> = {
  "0.0.0.0": true,
  "::": true,
  "::ffff:0:0": true,
};

export function validateIpAllowlist(allowlist: string[]): ValidationResult {
  if (allowlist.length === 0) {
    return { valid: false, reason: "IP allowlist must contain unique literal IP addresses." };
  }
  const seen = new Set<string>();
  for (const ip of allowlist) {
    const version = isIP(ip);
    if (version === 0 || ip.includes("%")) {
      return { valid: false, reason: "IP allowlist must contain unique literal IP addresses." };
    }
    const normalized = version === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
    if (Object.hasOwn(WILDCARD_IPS, normalized)) {
      return { valid: false, reason: "IP allowlist must not include wildcard addresses." };
    }
    if (seen.has(normalized)) {
      return { valid: false, reason: "IP allowlist must contain unique literal IP addresses." };
    }
    seen.add(normalized);
  }
  return { valid: true };
}

// Live mainnet keys are checked via signed GET https://api.binance.com/sapi/v1/account/apiRestrictions.
export function validateNoWithdrawalKey(permissions: BinanceApiKeyPermissions): ValidationResult {
  if (permissions.enableWithdrawals !== false) {
    return { valid: false, reason: "Binance API key must have withdrawals disabled." };
  }
  return { valid: true };
}

export function validateIpRestriction(permissions: BinanceApiKeyPermissions): ValidationResult {
  if (permissions.ipRestrict !== true) {
    return { valid: false, reason: "Binance API key must be IP restricted." };
  }
  return { valid: true };
}

export function validateLiveKeyPermissions(
  permissions: BinanceApiKeyPermissions,
  intent: TradingIntent,
  config: BinanceConfig,
): ValidationResult {
  const withdrawal = validateNoWithdrawalKey(permissions);
  if (!withdrawal.valid) return withdrawal;
  const restricted = validateIpRestriction(permissions);
  if (!restricted.valid) return restricted;
  const requireReading =
    intent.action === "cex.place_order" || intent.action === "cex.get_order_status";
  if (requireReading && permissions.enableReading !== true) {
    return { valid: false, reason: "Binance API key must allow reading." };
  }
  let requireSpot = false;
  let requireFutures = false;
  if (intent.action === "cex.place_order" || intent.action === "cex.cancel_order") {
    if ("accountMode" in intent && intent.accountMode === "usdm_futures") {
      requireFutures = true;
    } else if ("accountMode" in intent && intent.accountMode === "spot") {
      requireSpot = true;
    } else if ("symbol" in intent) {
      requireSpot = config.allowedSpotSymbols.includes(intent.symbol);
      requireFutures = config.allowedFuturesSymbols.includes(intent.symbol);
    }
  }
  if (requireSpot && permissions.enableSpotAndMarginTrading !== true) {
    return { valid: false, reason: "Binance API key must allow spot trading." };
  }
  if (requireFutures && permissions.enableFutures !== true) {
    return { valid: false, reason: "Binance API key must allow futures trading." };
  }
  return { valid: true };
}
