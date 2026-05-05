import type { TradingIntent } from "@guardrails/schemas";
import type { BinanceConfig } from "./interfaces.js";

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
