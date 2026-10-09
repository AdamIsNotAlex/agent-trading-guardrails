import { readFile } from "node:fs/promises";
import { DEFAULT_CANARY_LIVE_LIMITS, RiskEngine } from "@guardrails/risk-engine";
import type { RiskEngine as ServiceRiskEngine } from "@guardrails/service";
import { z } from "zod";

const timestamp = z.number().finite().nonnegative();
const snapshotSchema = z.object({
  marketData: z.array(
    z.object({
      symbol: z.string().min(1),
      price: z.number().finite().positive(),
      timestampMs: timestamp,
    }),
  ),
  portfolios: z.array(
    z.object({
      account: z.string().min(1),
      timestampMs: timestamp,
      positions: z.array(
        z.object({
          symbol: z.string().min(1),
          quantity: z.number().finite(),
          notionalUsd: z.number().finite(),
        }),
      ),
    }),
  ),
  dailyStats: z.array(
    z.object({
      account: z.string().min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      totalNotionalUsd: z.number().finite().nonnegative(),
      realizedLossUsd: z.number().finite().nonnegative(),
      orderCount: z.number().int().nonnegative(),
    }),
  ),
  lastOrderTimestamps: z.record(timestamp.nullable()),
});

// One trusted, atomically replaced snapshot per evaluation; never derive risk facts from the intent.
export function createFileRiskEngine(path: string): ServiceRiskEngine {
  return {
    async evaluate(intent, verdict) {
      const snapshot = snapshotSchema.parse(JSON.parse(await readFile(path, "utf8")));
      const engine = new RiskEngine(
        {
          async getMarketData(symbol) {
            return snapshot.marketData.find((data) => data.symbol === symbol) ?? null;
          },
          async getPortfolio(account) {
            return snapshot.portfolios.find((data) => data.account === account) ?? null;
          },
          async getDailyStats(account, date) {
            return (
              snapshot.dailyStats.find((data) => data.account === account && data.date === date) ??
              null
            );
          },
          async getLastOrderTimestampMs(account) {
            if (!Object.hasOwn(snapshot.lastOrderTimestamps, account)) {
              throw new Error("Order history is unavailable for this account.");
            }
            return snapshot.lastOrderTimestamps[account];
          },
        },
        DEFAULT_CANARY_LIVE_LIMITS,
      );
      return engine.evaluate(intent, verdict);
    },
  };
}
