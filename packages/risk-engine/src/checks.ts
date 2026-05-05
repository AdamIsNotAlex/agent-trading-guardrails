import type { ReviewerVerdictSchema, RiskCheckResult, TradingIntent } from "@guardrails/schemas";
import type { RiskLimits } from "./config.js";
import type { RiskDataProvider } from "./providers.js";

export async function checkMarketDataFreshness(
  provider: RiskDataProvider,
  intent: TradingIntent,
  limits: RiskLimits,
  nowMs: number,
): Promise<RiskCheckResult> {
  if (intent.action !== "cex.place_order" || !("symbol" in intent)) {
    return { check: "market_data_freshness", status: "pass" };
  }
  const data = await provider.getMarketData(intent.symbol);
  if (!data) {
    return {
      check: "market_data_freshness",
      status: "unavailable",
      message: "Market data not available.",
    };
  }
  const ageMs = nowMs - data.timestampMs;
  if (ageMs > limits.maxMarketDataAgeMs) {
    return {
      check: "market_data_freshness",
      status: "fail",
      value: ageMs,
      threshold: limits.maxMarketDataAgeMs,
      message: `Market data is ${ageMs}ms old, max ${limits.maxMarketDataAgeMs}ms.`,
    };
  }
  return {
    check: "market_data_freshness",
    status: "pass",
    value: ageMs,
    threshold: limits.maxMarketDataAgeMs,
  };
}

export async function checkPortfolioFreshness(
  provider: RiskDataProvider,
  intent: TradingIntent,
  limits: RiskLimits,
  nowMs: number,
): Promise<RiskCheckResult> {
  if (intent.action !== "cex.place_order" || !("account" in intent)) {
    return { check: "portfolio_freshness", status: "pass" };
  }
  const portfolio = await provider.getPortfolio(intent.account);
  if (!portfolio) {
    return {
      check: "portfolio_freshness",
      status: "unavailable",
      message: "Portfolio data not available.",
    };
  }
  const ageMs = nowMs - portfolio.timestampMs;
  if (ageMs > limits.maxPortfolioAgeMs) {
    return {
      check: "portfolio_freshness",
      status: "fail",
      value: ageMs,
      threshold: limits.maxPortfolioAgeMs,
      message: `Portfolio data is ${ageMs}ms old, max ${limits.maxPortfolioAgeMs}ms.`,
    };
  }
  return {
    check: "portfolio_freshness",
    status: "pass",
    value: ageMs,
    threshold: limits.maxPortfolioAgeMs,
  };
}

export function checkPerOrderNotional(intent: TradingIntent, limits: RiskLimits): RiskCheckResult {
  if (!("maxNotionalUsd" in intent)) {
    return { check: "per_order_notional", status: "pass" };
  }
  if (intent.maxNotionalUsd > limits.maxNotionalUsd) {
    return {
      check: "per_order_notional",
      status: "fail",
      value: intent.maxNotionalUsd,
      threshold: limits.maxNotionalUsd,
      message: `Notional $${intent.maxNotionalUsd} exceeds limit $${limits.maxNotionalUsd}.`,
    };
  }
  return {
    check: "per_order_notional",
    status: "pass",
    value: intent.maxNotionalUsd,
    threshold: limits.maxNotionalUsd,
  };
}

export async function checkDailyNotional(
  provider: RiskDataProvider,
  intent: TradingIntent,
  limits: RiskLimits,
): Promise<RiskCheckResult> {
  if (!("account" in intent) || !("maxNotionalUsd" in intent)) {
    return { check: "daily_notional", status: "pass" };
  }
  const today = new Date().toISOString().slice(0, 10);
  const stats = await provider.getDailyStats(intent.account, today);
  if (!stats) {
    return {
      check: "daily_notional",
      status: "unavailable",
      message: "Daily stats not available.",
    };
  }
  const projected = stats.totalNotionalUsd + intent.maxNotionalUsd;
  if (projected > limits.maxDailyNotionalUsd) {
    return {
      check: "daily_notional",
      status: "fail",
      value: projected,
      threshold: limits.maxDailyNotionalUsd,
      message: `Projected daily notional $${projected} exceeds limit $${limits.maxDailyNotionalUsd}.`,
    };
  }
  return {
    check: "daily_notional",
    status: "pass",
    value: projected,
    threshold: limits.maxDailyNotionalUsd,
  };
}

export async function checkDailyLoss(
  provider: RiskDataProvider,
  intent: TradingIntent,
  limits: RiskLimits,
): Promise<RiskCheckResult> {
  if (intent.action !== "cex.place_order" || !("account" in intent)) {
    return { check: "daily_loss", status: "pass" };
  }
  const today = new Date().toISOString().slice(0, 10);
  const stats = await provider.getDailyStats(intent.account, today);
  if (!stats) {
    return { check: "daily_loss", status: "unavailable", message: "Daily stats not available." };
  }
  if (stats.realizedLossUsd > limits.maxDailyLossUsd) {
    return {
      check: "daily_loss",
      status: "fail",
      value: stats.realizedLossUsd,
      threshold: limits.maxDailyLossUsd,
      message: `Daily loss $${stats.realizedLossUsd} exceeds limit $${limits.maxDailyLossUsd}.`,
    };
  }
  return {
    check: "daily_loss",
    status: "pass",
    value: stats.realizedLossUsd,
    threshold: limits.maxDailyLossUsd,
  };
}

export function checkSlippage(intent: TradingIntent, limits: RiskLimits): RiskCheckResult {
  if (!("maxSlippageBps" in intent)) {
    return { check: "slippage", status: "pass" };
  }
  if (intent.maxSlippageBps > limits.maxSlippageBps) {
    return {
      check: "slippage",
      status: "fail",
      value: intent.maxSlippageBps,
      threshold: limits.maxSlippageBps,
      message: `Slippage ${intent.maxSlippageBps}bps exceeds limit ${limits.maxSlippageBps}bps.`,
    };
  }
  return {
    check: "slippage",
    status: "pass",
    value: intent.maxSlippageBps,
    threshold: limits.maxSlippageBps,
  };
}

export async function checkPositionDelta(
  provider: RiskDataProvider,
  intent: TradingIntent,
  limits: RiskLimits,
): Promise<RiskCheckResult> {
  if (!("account" in intent) || !("symbol" in intent) || !("maxNotionalUsd" in intent)) {
    return { check: "position_delta", status: "pass" };
  }
  const portfolio = await provider.getPortfolio(intent.account);
  if (!portfolio) {
    return { check: "position_delta", status: "unavailable", message: "Portfolio not available." };
  }
  const position = portfolio.positions.find((p) => p.symbol === intent.symbol);
  const currentNotional = position?.notionalUsd ?? 0;
  if (currentNotional === 0) {
    return { check: "position_delta", status: "pass" };
  }
  const deltaPct = (intent.maxNotionalUsd / currentNotional) * 100;
  if (deltaPct > limits.maxPositionDeltaPct) {
    return {
      check: "position_delta",
      status: "fail",
      value: deltaPct,
      threshold: limits.maxPositionDeltaPct,
      message: `Position delta ${deltaPct.toFixed(1)}% exceeds limit ${limits.maxPositionDeltaPct}%.`,
    };
  }
  return {
    check: "position_delta",
    status: "pass",
    value: deltaPct,
    threshold: limits.maxPositionDeltaPct,
  };
}

export async function checkOrderFrequency(
  provider: RiskDataProvider,
  intent: TradingIntent,
  limits: RiskLimits,
  nowMs: number,
): Promise<RiskCheckResult> {
  if (intent.action !== "cex.place_order" || !("account" in intent)) {
    return { check: "order_frequency", status: "pass" };
  }
  const lastTs = await provider.getLastOrderTimestampMs(intent.account);
  if (lastTs === null) {
    return { check: "order_frequency", status: "pass" };
  }
  const elapsed = nowMs - lastTs;
  if (elapsed < limits.minOrderIntervalMs) {
    return {
      check: "order_frequency",
      status: "fail",
      value: elapsed,
      threshold: limits.minOrderIntervalMs,
      message: `Only ${elapsed}ms since last order, min ${limits.minOrderIntervalMs}ms.`,
    };
  }
  return {
    check: "order_frequency",
    status: "pass",
    value: elapsed,
    threshold: limits.minOrderIntervalMs,
  };
}

export function checkEvidenceReferences(intent: TradingIntent): RiskCheckResult {
  if (!intent.evidence || intent.evidence.length === 0) {
    return {
      check: "evidence_references",
      status: "fail",
      message: "No evidence references provided.",
    };
  }
  for (const ref of intent.evidence) {
    if (!ref || ref.trim().length === 0) {
      return {
        check: "evidence_references",
        status: "fail",
        message: "Empty evidence reference found.",
      };
    }
  }
  return { check: "evidence_references", status: "pass" };
}

export function checkReviewerConsistency(
  intent: TradingIntent,
  verdict: ReviewerVerdictSchema,
): RiskCheckResult {
  if (verdict.intentId !== intent.intentId) {
    return {
      check: "reviewer_consistency",
      status: "fail",
      message: "Reviewer verdict intentId does not match intent.",
    };
  }
  if (verdict.verdict === "approve" && verdict.detectedIssues.length > 0) {
    return {
      check: "reviewer_consistency",
      status: "fail",
      message: "Reviewer approved but detected issues present.",
    };
  }
  return { check: "reviewer_consistency", status: "pass" };
}
