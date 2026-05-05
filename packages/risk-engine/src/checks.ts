import type { ReviewerVerdictSchema, RiskCheckResult, TradingIntent } from "@guardrails/schemas";
import type { RiskLimits } from "./config.js";
import type { DailyStats, MarketDataSnapshot, RiskDataProvider } from "./providers.js";

export function checkMarketDataFreshness(
  intent: TradingIntent,
  limits: RiskLimits,
  nowMs: number,
  data: MarketDataSnapshot | null | undefined,
): RiskCheckResult {
  if (intent.action !== "cex.place_order" || !("symbol" in intent)) {
    return { check: "market_data_freshness", status: "pass" };
  }
  if (!Number.isFinite(limits.maxMarketDataAgeMs) || limits.maxMarketDataAgeMs < 0) {
    return {
      check: "market_data_freshness",
      status: "unavailable",
      message: "Market data freshness limit unavailable or invalid.",
    };
  }
  if (!data || data.symbol !== intent.symbol || !Number.isFinite(data.timestampMs)) {
    return {
      check: "market_data_freshness",
      status: "unavailable",
      message: "Market data unavailable or invalid.",
    };
  }
  const ageMs = nowMs - data.timestampMs;
  if (ageMs < 0) {
    return {
      check: "market_data_freshness",
      status: "unavailable",
      message: "Market data unavailable or invalid.",
    };
  }
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
  if (portfolio.account !== intent.account) {
    return {
      check: "portfolio_freshness",
      status: "unavailable",
      message: "Portfolio account does not match intent account.",
    };
  }
  const ageMs = nowMs - portfolio.timestampMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return {
      check: "portfolio_freshness",
      status: "unavailable",
      message: "Portfolio timestamp is invalid.",
    };
  }
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

export function checkDailyNotional(
  intent: TradingIntent,
  limits: RiskLimits,
  stats: DailyStats | null | undefined,
): RiskCheckResult {
  if (
    intent.action !== "cex.place_order" ||
    !("account" in intent) ||
    !("maxNotionalUsd" in intent)
  ) {
    return { check: "daily_notional", status: "pass" };
  }
  if (!stats) {
    return {
      check: "daily_notional",
      status: "unavailable",
      message: "Daily stats not available.",
    };
  }
  if (!Number.isFinite(stats.totalNotionalUsd) || stats.totalNotionalUsd < 0) {
    return {
      check: "daily_notional",
      status: "unavailable",
      message: "Daily notional stats are invalid.",
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

export function checkDailyLoss(
  intent: TradingIntent,
  limits: RiskLimits,
  stats: DailyStats | null | undefined,
): RiskCheckResult {
  if (intent.action !== "cex.place_order" || !("account" in intent)) {
    return { check: "daily_loss", status: "pass" };
  }
  if (!stats) {
    return { check: "daily_loss", status: "unavailable", message: "Daily stats not available." };
  }
  if (!Number.isFinite(stats.realizedLossUsd) || stats.realizedLossUsd < 0) {
    return { check: "daily_loss", status: "unavailable", message: "Daily loss stats are invalid." };
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

export function checkPriceBand(
  intent: TradingIntent,
  limits: RiskLimits,
  nowMs: number,
  data: MarketDataSnapshot | null | undefined,
): RiskCheckResult {
  if (intent.action !== "cex.place_order" || !("symbol" in intent)) {
    return { check: "price_band", status: "pass" };
  }
  if (
    !("price" in intent) ||
    intent.price == null ||
    !Number.isFinite(intent.price) ||
    intent.price <= 0
  ) {
    return {
      check: "price_band",
      status: "unavailable",
      message: "Intent price unavailable or invalid.",
    };
  }
  if (
    !data ||
    data.symbol !== intent.symbol ||
    !Number.isFinite(data.timestampMs) ||
    !Number.isFinite(data.price) ||
    data.price <= 0
  ) {
    return {
      check: "price_band",
      status: "unavailable",
      message: "Market data unavailable or invalid.",
    };
  }
  if (!Number.isFinite(limits.maxMarketDataAgeMs) || limits.maxMarketDataAgeMs < 0) {
    return {
      check: "price_band",
      status: "unavailable",
      message: "Market data freshness limit unavailable or invalid.",
    };
  }
  const ageMs = nowMs - data.timestampMs;
  if (ageMs < 0 || ageMs > limits.maxMarketDataAgeMs) {
    return {
      check: "price_band",
      status: "unavailable",
      message: "Market data unavailable or invalid.",
    };
  }
  if (!Number.isFinite(limits.maxPriceBandBps) || limits.maxPriceBandBps < 0) {
    return {
      check: "price_band",
      status: "unavailable",
      message: "Price band limit unavailable or invalid.",
    };
  }
  const deviationBps = Math.abs((intent.price - data.price) / data.price) * 10_000;
  if (deviationBps > limits.maxPriceBandBps) {
    return {
      check: "price_band",
      status: "fail",
      value: deviationBps,
      threshold: limits.maxPriceBandBps,
      message: `Price band ${deviationBps.toFixed(1)}bps exceeds limit ${limits.maxPriceBandBps}bps.`,
    };
  }
  return {
    check: "price_band",
    status: "pass",
    value: deviationBps,
    threshold: limits.maxPriceBandBps,
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
  if (portfolio.account !== intent.account) {
    return {
      check: "position_delta",
      status: "unavailable",
      message: "Portfolio account does not match intent account.",
    };
  }
  const position = portfolio.positions.find((p) => p.symbol === intent.symbol);
  if (position && !Number.isFinite(position.notionalUsd)) {
    return {
      check: "position_delta",
      status: "unavailable",
      message: "Position notional is invalid.",
    };
  }
  const currentNotional = Math.abs(position?.notionalUsd ?? 0);
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
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return {
      check: "order_frequency",
      status: "unavailable",
      message: "Last order timestamp is invalid.",
    };
  }
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

export function checkDailyOrderCount(
  intent: TradingIntent,
  limits: RiskLimits,
  stats: DailyStats | null | undefined,
): RiskCheckResult {
  if (intent.action !== "cex.place_order" || !("account" in intent)) {
    return { check: "daily_order_count", status: "pass" };
  }
  if (!stats) {
    return {
      check: "daily_order_count",
      status: "unavailable",
      message: "Daily stats not available.",
    };
  }
  if (!Number.isFinite(stats.orderCount) || stats.orderCount < 0) {
    return {
      check: "daily_order_count",
      status: "unavailable",
      message: "Daily order count stats are invalid.",
    };
  }
  const projected = stats.orderCount + 1;
  if (projected > limits.maxOrdersPerDay) {
    return {
      check: "daily_order_count",
      status: "fail",
      value: projected,
      threshold: limits.maxOrdersPerDay,
      message: `Projected daily order count ${projected} exceeds limit ${limits.maxOrdersPerDay}.`,
    };
  }
  return {
    check: "daily_order_count",
    status: "pass",
    value: projected,
    threshold: limits.maxOrdersPerDay,
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
