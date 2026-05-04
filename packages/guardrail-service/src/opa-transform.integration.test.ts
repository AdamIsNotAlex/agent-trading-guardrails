import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { transformOpaOutput } from "./opa-transform.js";

function hasOpaCli(): boolean {
  try {
    execFileSync("opa", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(hasOpaCli())("transformOpaOutput with real Rego output", () => {
  it("validates OPA eval output against PolicyOutput", () => {
    const dir = mkdtempSync(join(tmpdir(), "guardrails-opa-"));
    const inputPath = join(dir, "input.json");

    try {
      writeFileSync(
        inputPath,
        JSON.stringify({
          intentId: "550e8400-e29b-41d4-a716-446655440000",
          principal: "agent:test",
          action: "cex.withdraw",
          resource: "binance:spot:BTCUSDT",
          environment: "dev",
          reviewerVerdict: "approve",
          reviewerRiskLevel: "low",
        }),
      );

      const result = execFileSync(
        "opa",
        [
          "eval",
          "--format",
          "json",
          "--data",
          "packages/policy/src",
          "--input",
          inputPath,
          "data.guardrail",
        ],
        { encoding: "utf8" },
      );
      const parsed = JSON.parse(result) as {
        result: Array<{ expressions: Array<{ value: unknown }> }>;
      };
      const rawOutput = parsed.result[0].expressions[0].value as Record<string, unknown>;
      const output = transformOpaOutput(rawOutput);

      expect(output.decision).toBe("deny");
      expect(output.matchedDenyRules).toContain("withdrawal_denied");
      expect(output.reasons).toContainEqual({
        rule: "withdrawal_denied",
        message: "CEX withdrawals are not permitted.",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
