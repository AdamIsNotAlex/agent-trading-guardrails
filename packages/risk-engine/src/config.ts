export interface RiskLimits {
  maxMarketDataAgeMs: number;
  maxPortfolioAgeMs: number;
  maxNotionalUsd: number;
  maxDailyNotionalUsd: number;
  maxDailyLossUsd: number;
  maxSlippageBps: number;
  maxPositionDeltaPct: number;
  minOrderIntervalMs: number;
  maxOrdersPerDay: number;
}

export const DEFAULT_CANARY_LIVE_LIMITS: RiskLimits = {
  maxMarketDataAgeMs: 10_000,
  maxPortfolioAgeMs: 30_000,
  maxNotionalUsd: 10,
  maxDailyNotionalUsd: 50,
  maxDailyLossUsd: 25,
  maxSlippageBps: 50,
  maxPositionDeltaPct: 10,
  minOrderIntervalMs: 5_000,
  maxOrdersPerDay: 25,
};
