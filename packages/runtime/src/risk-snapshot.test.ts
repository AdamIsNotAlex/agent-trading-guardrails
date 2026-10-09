import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewerVerdictSchema } from "@guardrails/schemas";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileRiskEngine } from "./risk-snapshot.js";

let directory: string;
let path: string;
const intent = { ...binanceSpotOrder, environment: "dev" as const };
const verdict: ReviewerVerdictSchema = {
  intentId: intent.intentId,
  verdict: "approve",
  riskLevel: "low",
  reasons: ["Evidence supports the order."],
  detectedIssues: [],
  requiredPolicyTags: [],
  reviewerModel: "test",
  reviewerProvider: "test",
  reviewedAt: "2026-05-04T12:00:00.000Z",
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "risk-snapshot-"));
  path = join(directory, "snapshot.json");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function snapshot() {
  return {
    marketData: [{ symbol: intent.symbol, price: intent.price, timestampMs: Date.now() }],
    portfolios: [{ account: intent.account, timestampMs: Date.now(), positions: [] }],
    dailyStats: [
      {
        account: intent.account,
        date: new Date().toISOString().slice(0, 10),
        totalNotionalUsd: 0,
        realizedLossUsd: 0,
        orderCount: 0,
      },
    ],
    lastOrderTimestamps: { [intent.account]: null },
  };
}

describe("file-backed runtime risk facts", () => {
  it("reloads trusted data for each evaluation instead of using intent prices as market data", async () => {
    const data = snapshot();
    writeFileSync(path, JSON.stringify(data));
    const engine = createFileRiskEngine(path);
    expect((await engine.evaluate(intent, verdict)).passed).toBe(true);
    data.marketData[0].price = 1;
    writeFileSync(path, JSON.stringify(data));
    const changed = await engine.evaluate(intent, verdict);
    expect(changed.passed).toBe(false);
    expect(changed.checks).toContainEqual(
      expect.objectContaining({
        check: "price_band",
        status: "fail",
      }),
    );
  });

  it("does not treat missing order history as an explicit no-orders snapshot", async () => {
    const data = { ...snapshot(), lastOrderTimestamps: {} };
    writeFileSync(path, JSON.stringify(data));
    await expect(createFileRiskEngine(path).evaluate(intent, verdict)).rejects.toThrow();
  });

  it("does not reuse previously valid facts after the feed becomes unreadable", async () => {
    writeFileSync(path, JSON.stringify(snapshot()));
    const engine = createFileRiskEngine(path);
    expect((await engine.evaluate(intent, verdict)).passed).toBe(true);
    writeFileSync(path, "{");
    await expect(engine.evaluate(intent, verdict)).rejects.toThrow();
  });
});
