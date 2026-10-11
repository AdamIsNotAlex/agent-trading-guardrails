import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore } from "@guardrails/approval";
import type { OnchainSigningIntent, PolicyInput } from "@guardrails/schemas";
import { PolicyOutput as PolicyOutputValidator } from "@guardrails/schemas";
import { ethereumSepoliaSigning, solanaDevnetSigning } from "@guardrails/schemas/fixtures";
import { describe, expect, it } from "vitest";
import { transformOpaOutput } from "./opa-transform.js";
import { GuardrailService } from "./service.js";

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
      const output = PolicyOutputValidator.parse(transformOpaOutput(rawOutput));

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

  const system = "11111111111111111111111111111111";
  const mint = "So11111111111111111111111111111111111111112";
  const token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const key = (pubkey: string, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  const nativeInstruction = {
    programId: system,
    data: "0x020000000100000000000000",
    keys: [key(system, true), key(mint)],
  };
  const tokenInstruction = {
    programId: token,
    data: "0x0c010000000000000009",
    keys: [key(system), key(mint), key(token), key(system, true)],
  };

  it.each([
    {
      name: "Ethereum transfer",
      fixture: ethereumSepoliaSigning,
      instructions: undefined,
      to: ethereumSepoliaSigning.to,
      outcome: "needs_human",
    },
    {
      name: "encoded SOL transfer",
      fixture: solanaDevnetSigning,
      instructions: [nativeInstruction],
      to: system,
      outcome: "needs_human",
    },
    {
      name: "encoded SPL TransferChecked",
      fixture: solanaDevnetSigning,
      instructions: [tokenInstruction],
      to: token,
      outcome: "needs_human",
    },
    {
      name: "caller-labeled encoded Solana instruction",
      fixture: solanaDevnetSigning,
      instructions: [{ ...nativeInstruction, type: "transfer" }],
      to: system,
      outcome: "deny",
    },
    {
      name: "encoded Solana authority change",
      fixture: solanaDevnetSigning,
      instructions: [{ ...tokenInstruction, data: "Bg==" }],
      to: token,
      outcome: "deny",
    },
    {
      name: "mixed safe and unsupported Solana instructions",
      fixture: solanaDevnetSigning,
      instructions: [nativeInstruction, { ...nativeInstruction, data: "0x00" }],
      to: system,
      outcome: "deny",
    },
  ])("routes $name through real policy and mainnet approval state", async ({
    fixture,
    instructions,
    to,
    outcome,
  }) => {
    const approvals = new ApprovalStore({ databasePath: ":memory:", defaultTimeoutSeconds: 300 });
    const service = new GuardrailService(
      {
        environment: "canary_live",
        opaUrl: "http://unused.invalid",
        approvalTimeoutSeconds: 300,
        decisionSigningSecret: "mainnet-integration-decision-secret-32-bytes",
      },
      {
        async review(intent) {
          return {
            intentId: intent.intentId,
            verdict: "approve",
            riskLevel: "low",
            reasons: ["Reviewed test intent."],
            detectedIssues: [],
            requiredPolicyTags: [],
            reviewerModel: "fixture",
            reviewerProvider: "fixture",
            reviewedAt: new Date().toISOString(),
          };
        },
      },
      {
        async evaluate(input: PolicyInput) {
          const raw = execFileSync(
            "opa",
            [
              "eval",
              "--format",
              "json",
              "--data",
              "packages/policy/src",
              "--stdin-input",
              "data.guardrail",
            ],
            {
              input: JSON.stringify(input),
              encoding: "utf8",
            },
          );
          return JSON.parse(raw).result[0].expressions[0].value;
        },
        async isHealthy() {
          return true;
        },
      },
      {
        async evaluate(intent) {
          return {
            intentId: intent.intentId,
            passed: true,
            checks: [{ check: "evidence_references", status: "pass" }],
            evaluatedAt: new Date().toISOString(),
          };
        },
      },
      { write() {} },
      approvals,
    );
    const intent: OnchainSigningIntent = {
      ...fixture,
      chainEnvironment: "mainnet",
      environment: "canary_live",
      resource: `onchain:${fixture.chain}:mainnet:${to}`,
      to,
      ...(fixture.chain === "solana" ? { programId: to, instructions } : {}),
    };
    try {
      const decision = await service.evaluate(intent);
      expect(decision.outcome).toBe(outcome);
      if (outcome === "needs_human") {
        expect(decision.reasons.map((reason) => reason.rule)).toContain(
          "mainnet_signing_requires_human",
        );
        expect(approvals.get(decision.approvalId ?? "")).toMatchObject({
          state: "pending",
          environment: "canary_live",
          intentId: intent.intentId,
          intentData: intent,
        });
      } else {
        expect(decision.reasons.map((reason) => reason.rule)).toContain(
          "solana_instruction_type_unknown",
        );
        expect(approvals.list()).toEqual([]);
      }
    } finally {
      approvals.close();
    }
  });
});
