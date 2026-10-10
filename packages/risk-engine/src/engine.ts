import type {
  DynamicRiskResult,
  ReviewerVerdictSchema,
  RiskCheckResult,
  TradingIntent,
} from "@guardrails/schemas";
import {
  checkDailyLoss,
  checkDailyNotional,
  checkDailyOrderCount,
  checkEvidenceReferences,
  checkMarketDataFreshness,
  checkOrderFrequency,
  checkPerOrderNotional,
  checkPortfolioFreshness,
  checkPositionDelta,
  checkPriceBand,
  checkReviewerConsistency,
  checkSlippage,
} from "./checks.js";
import type { RiskLimits } from "./config.js";
import type { RiskDataProvider } from "./providers.js";

export class RiskEngine {
  constructor(
    private provider: RiskDataProvider,
    private limits: RiskLimits,
  ) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Risk limit ${name} must be a finite nonnegative number.`);
      }
    }
  }

  async evaluate(
    intent: TradingIntent,
    reviewerVerdict: ReviewerVerdictSchema,
  ): Promise<DynamicRiskResult> {
    const checks: RiskCheckResult[] = [];
    const today = new Date().toISOString().slice(0, 10);
    const rawDailyStats =
      intent.action === "cex.place_order" && "account" in intent
        ? await this.provider.getDailyStats(intent.account, today)
        : undefined;
    const dailyStatsSnapshot =
      rawDailyStats &&
      intent.action === "cex.place_order" &&
      "account" in intent &&
      rawDailyStats.account === intent.account &&
      rawDailyStats.date === today
        ? rawDailyStats
        : null;
    const marketDataSnapshot =
      intent.action === "cex.place_order" && "symbol" in intent
        ? await this.provider.getMarketData(intent.symbol)
        : undefined;
    const portfolioSnapshot =
      intent.action === "cex.place_order"
        ? await this.provider.getPortfolio(intent.account)
        : undefined;
    const lastOrderTimestamp =
      intent.action === "cex.place_order"
        ? await this.provider.getLastOrderTimestampMs(intent.account)
        : undefined;
    const nowMs = Date.now();
    if (new Date(nowMs).toISOString().slice(0, 10) !== today) {
      throw new Error("Risk data collection crossed a UTC day boundary; evaluate again.");
    }

    checks.push(checkMarketDataFreshness(intent, this.limits, nowMs, marketDataSnapshot));
    checks.push(checkPriceBand(intent, this.limits, nowMs, marketDataSnapshot));
    checks.push(checkPortfolioFreshness(portfolioSnapshot, intent, this.limits, nowMs));
    checks.push(checkPerOrderNotional(intent, this.limits));
    checks.push(checkDailyNotional(intent, this.limits, dailyStatsSnapshot));
    checks.push(checkDailyLoss(intent, this.limits, dailyStatsSnapshot));
    checks.push(checkSlippage(intent, this.limits));
    checks.push(checkPositionDelta(portfolioSnapshot, intent, this.limits));
    checks.push(checkOrderFrequency(lastOrderTimestamp, intent, this.limits, nowMs));
    checks.push(checkDailyOrderCount(intent, this.limits, dailyStatsSnapshot));
    checks.push(checkEvidenceReferences(intent));
    checks.push(checkReviewerConsistency(intent, reviewerVerdict));

    const dailyStats = dailyStatsSnapshot ?? undefined;
    const passed = checks.every((c) => c.status === "pass");

    return {
      intentId: intent.intentId,
      passed,
      checks,
      dailyStats,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
