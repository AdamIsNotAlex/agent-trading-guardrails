import type {
  DynamicRiskResult,
  ReviewerVerdictSchema,
  RiskCheckResult,
  TradingIntent,
} from "@guardrails/schemas";
import {
  checkDailyLoss,
  checkDailyNotional,
  checkEvidenceReferences,
  checkMarketDataFreshness,
  checkOrderFrequency,
  checkPerOrderNotional,
  checkPortfolioFreshness,
  checkPositionDelta,
  checkReviewerConsistency,
  checkSlippage,
} from "./checks.js";
import type { RiskLimits } from "./config.js";
import type { RiskDataProvider } from "./providers.js";

export class RiskEngine {
  constructor(
    private provider: RiskDataProvider,
    private limits: RiskLimits,
  ) {}

  async evaluate(
    intent: TradingIntent,
    reviewerVerdict: ReviewerVerdictSchema,
  ): Promise<DynamicRiskResult> {
    const nowMs = Date.now();
    const checks: RiskCheckResult[] = [];

    checks.push(await checkMarketDataFreshness(this.provider, intent, this.limits, nowMs));
    checks.push(await checkPortfolioFreshness(this.provider, intent, this.limits, nowMs));
    checks.push(checkPerOrderNotional(intent, this.limits));
    checks.push(await checkDailyNotional(this.provider, intent, this.limits));
    checks.push(await checkDailyLoss(this.provider, intent, this.limits));
    checks.push(checkSlippage(intent, this.limits));
    checks.push(await checkPositionDelta(this.provider, intent, this.limits));
    checks.push(await checkOrderFrequency(this.provider, intent, this.limits, nowMs));
    checks.push(checkEvidenceReferences(intent));
    checks.push(checkReviewerConsistency(intent, reviewerVerdict));

    const passed = checks.every((c) => c.status === "pass");

    return {
      intentId: intent.intentId,
      passed,
      checks,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
