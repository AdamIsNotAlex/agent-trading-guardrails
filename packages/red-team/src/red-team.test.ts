import { ApprovalStore } from "@guardrails/approval";
import {
  createGuardrailDecisionToken,
  ExecutionBroker,
  InMemoryBrokerIdempotencyStore,
  InMemoryKillSwitch,
  PaperExecutionConnector,
} from "@guardrails/broker";
import type {
  DynamicRiskResult,
  PolicyInput,
  PolicyOutput,
  ReviewerVerdictSchema,
  TradingIntent,
} from "@guardrails/schemas";
import { binanceSpotOrder, ethereumSepoliaSigning } from "@guardrails/schemas/fixtures";
import {
  type GuardrailConfig,
  GuardrailService,
  type PolicyEvaluator,
  type ReviewerAdapter,
  type RiskEngine,
} from "@guardrails/service";
import { describe, expect, it } from "vitest";
import { hallucinatedClaims, promptInjectionPayloads } from "./fixtures.js";

const now = "2026-05-04T12:00:00.000Z";
const UINT256_MAX =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const APPROVAL_SPENDER = "0000000000000000000000007265636970696e74000000000000000000000000";
const APPROVAL_AMOUNT_100 = "0000000000000000000000000000000000000000000000000000000000000064";
const ERC20_APPROVAL_100 = `0x095ea7b3${APPROVAL_SPENDER}${APPROVAL_AMOUNT_100}`;
const ERC20_APPROVAL_MAX = `0x095ea7b3${APPROVAL_SPENDER}${"f".repeat(64)}`;
const nullAuditWriter = { write() {} };
const brokerConfig = {
  environment: "canary_live" as const,
  canaryLiveEnabled: true,
  decisionVerificationSecret: "test-decision-secret-with-32-bytes",
};
const config: GuardrailConfig = {
  environment: "canary_live",
  opaUrl: "http://localhost:8181",
  approvalTimeoutSeconds: 300,
  decisionSigningSecret: "test-decision-secret-with-32-bytes",
};

function decisionToken(params: {
  intent: TradingIntent;
  outcome: "allow" | "needs_human";
  correlationId: string;
  approvalId?: string;
}): string {
  return createGuardrailDecisionToken({
    secret: brokerConfig.decisionVerificationSecret,
    decidedAt: now,
    ...params,
  });
}

function makeReviewer(verdict: ReviewerVerdictSchema["verdict"] = "approve"): ReviewerAdapter {
  return {
    async review(intent: TradingIntent): Promise<ReviewerVerdictSchema> {
      return {
        intentId: intent.intentId,
        verdict,
        riskLevel: "low",
        reasons: ["test"],
        detectedIssues: [],
        requiredPolicyTags: [],
        reviewerModel: "gpt-5.5",
        reviewerProvider: "openai",
        reviewedAt: now,
      };
    },
  };
}

function makeAllowPolicy(): PolicyEvaluator {
  return {
    async evaluate(): Promise<PolicyOutput> {
      return {
        decision: "allow",
        reasons: [],
        requiresHumanApproval: false,
        matchedAllowRules: ["test"],
        matchedDenyRules: [],
        evaluatedAt: now,
      };
    },
    async isHealthy() {
      return true;
    },
  };
}

function makeDenyPolicy(rule: string, msg: string): PolicyEvaluator {
  return {
    async evaluate(): Promise<PolicyOutput> {
      return {
        decision: "deny",
        reasons: [{ rule, message: msg }],
        requiresHumanApproval: false,
        matchedAllowRules: [],
        matchedDenyRules: [rule],
        evaluatedAt: now,
      };
    },
    async isHealthy() {
      return true;
    },
  };
}

function makeOnchainHardDenyPolicy(): PolicyEvaluator {
  return {
    async evaluate(input: PolicyInput): Promise<PolicyOutput> {
      if (input.chain === "ethereum" && input.contractAddress !== ethereumSepoliaSigning.to) {
        return {
          decision: "deny",
          reasons: [{ rule: "unknown_contract_denied", message: "Not in allowlist." }],
          requiresHumanApproval: false,
          matchedAllowRules: [],
          matchedDenyRules: ["unknown_contract_denied"],
          evaluatedAt: now,
        };
      }
      if (input.tokenApprovalUnlimited) {
        return {
          decision: "deny",
          reasons: [{ rule: "unlimited_approval_denied", message: "Unlimited approval." }],
          requiresHumanApproval: false,
          matchedAllowRules: [],
          matchedDenyRules: ["unlimited_approval_denied"],
          evaluatedAt: now,
        };
      }
      if (input.tokenApprovalAmountMissing) {
        return {
          decision: "deny",
          reasons: [{ rule: "token_approval_amount_missing", message: "metadata required" }],
          requiresHumanApproval: false,
          matchedAllowRules: [],
          matchedDenyRules: ["token_approval_amount_missing"],
          evaluatedAt: now,
        };
      }
      return {
        decision: "allow",
        reasons: [],
        requiresHumanApproval: false,
        matchedAllowRules: ["ethereum-sepolia-sign"],
        matchedDenyRules: [],
        evaluatedAt: now,
      };
    },
    async isHealthy() {
      return true;
    },
  };
}

function makeNeedsHumanPolicy(): PolicyEvaluator {
  return {
    async evaluate(): Promise<PolicyOutput> {
      return {
        decision: "needs_human",
        reasons: [{ rule: "threshold", message: "Above auto threshold." }],
        requiresHumanApproval: true,
        matchedAllowRules: [],
        matchedDenyRules: [],
        evaluatedAt: now,
      };
    },
    async isHealthy() {
      return true;
    },
  };
}

function makeRisk(pass = true): RiskEngine {
  return {
    async evaluate(intent: TradingIntent): Promise<DynamicRiskResult> {
      return {
        intentId: intent.intentId,
        passed: pass,
        checks: [{ check: "test", status: pass ? "pass" : "fail" }],
        evaluatedAt: now,
      };
    },
  };
}

describe("Prompt Injection", () => {
  it("rejects intent with webpage injection in rationale", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const intent = { ...binanceSpotOrder, rationale: promptInjectionPayloads.webpageInstruction };
    const result = await svc.evaluate(intent);
    expect(result.outcome).toBe("deny");
    expect(result.reasons[0].rule).toBe("prompt_injection_detected");
  });

  it("rejects intent with repo injection in rationale", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const intent = { ...binanceSpotOrder, rationale: promptInjectionPayloads.repoInstruction };
    const result = await svc.evaluate(intent);
    expect(result.outcome).toBe("deny");
    expect(result.reasons[0].rule).toBe("prompt_injection_detected");
  });

  it("rejects intent with token metadata injection", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const intent = { ...binanceSpotOrder, rationale: promptInjectionPayloads.tokenMetadata };
    const result = await svc.evaluate(intent);
    expect(result.outcome).toBe("deny");
    expect(result.reasons[0].rule).toBe("prompt_injection_detected");
  });

  it("rejects intent with MCP tool-definition injection", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const intent = { ...binanceSpotOrder, rationale: promptInjectionPayloads.mcpToolDefinition };
    const result = await svc.evaluate(intent);
    expect(result.outcome).toBe("deny");
    expect(result.reasons[0].rule).toBe("prompt_injection_detected");
  });

  it("secret exfiltration prompt does not leak secrets", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const intent = {
      ...binanceSpotOrder,
      rationale: promptInjectionPayloads.secretExfiltrationPrompt,
    };
    const result = await svc.evaluate(intent);
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("VAULT_TOKEN");
    expect(resultStr).not.toContain("API_SECRET");
    expect(resultStr).not.toContain("PRIVATE_KEY");
  });

  it("secret exfiltration log prompt does not leak secrets", async () => {
    const auditEvents: Array<{ eventType: string }> = [];
    const svc = new GuardrailService(config, makeReviewer(), makeAllowPolicy(), makeRisk(), {
      write: (event) => auditEvents.push(event),
    });
    const previousEnv = {
      VAULT_TOKEN: process.env.VAULT_TOKEN,
      API_SECRET: process.env.API_SECRET,
      PRIVATE_KEY: process.env.PRIVATE_KEY,
    };
    process.env.VAULT_TOKEN = "redteam-vault-token";
    process.env.API_SECRET = "redteam-api-secret";
    process.env.PRIVATE_KEY = "redteam-private-key";
    try {
      const intent = {
        ...binanceSpotOrder,
        rationale: promptInjectionPayloads.secretExfiltrationLog,
      };
      const result = await svc.evaluate(intent);
      const capturedOutput = JSON.stringify({ result, auditEvents });
      expect(result.outcome).toBe("deny");
      expect(result.reasons[0].rule).toBe("prompt_injection_detected");
      expect(auditEvents.map((event) => event.eventType)).toEqual([
        "intent.received",
        "decision.final",
      ]);
      expect(capturedOutput).not.toContain("redteam-vault-token");
      expect(capturedOutput).not.toContain("redteam-api-secret");
      expect(capturedOutput).not.toContain("redteam-private-key");
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe("Invalid Reviewer Output", () => {
  it("fails closed on malformed reviewer output", async () => {
    const badReviewer: ReviewerAdapter = {
      async review() {
        return { verdict: "invalid" } as unknown as ReviewerVerdictSchema;
      },
    };
    const svc = new GuardrailService(
      config,
      badReviewer,
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate(binanceSpotOrder);
    expect(result.outcome).toBe("deny");
  });

  it("fails closed when reviewer throws", async () => {
    const badReviewer: ReviewerAdapter = {
      async review() {
        throw new Error("reviewer crashed");
      },
    };
    const svc = new GuardrailService(
      config,
      badReviewer,
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate(binanceSpotOrder);
    expect(result.outcome).toBe("deny");
    expect(result.reasons[0].rule).toBe("reviewer_unavailable");
  });
});

describe("Auto-Execution Rules", () => {
  it("reviewer approve + matching allowlist auto-executes within low-risk limits", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer("approve"),
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate(binanceSpotOrder);
    expect(result.outcome).toBe("allow");
  });

  it("reviewer approve without matching allowlist does not auto-execute", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer("approve"),
      makeNeedsHumanPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate(binanceSpotOrder);
    expect(result.outcome).toBe("needs_human");
  });

  it("threshold breach returns needs_human when below hard-deny threshold", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer("approve"),
      makeNeedsHumanPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate(binanceSpotOrder);
    expect(result.outcome).toBe("needs_human");
    expect(result.requiresHumanApproval).toBe(true);
  });

  it("escalates non-interactively, accepts human approval, then executes", async () => {
    const approvalStore = new ApprovalStore({ defaultTimeoutSeconds: 300 });
    const svc = new GuardrailService(
      config,
      makeReviewer("approve"),
      makeNeedsHumanPolicy(),
      makeRisk(),
      nullAuditWriter,
      approvalStore,
    );
    const decision = await svc.evaluate(binanceSpotOrder);
    const approvalId = decision.approvalId ?? "";
    approvalStore.approve(approvalId, "operator");
    const broker = new ExecutionBroker(
      brokerConfig,
      new PaperExecutionConnector(),
      new InMemoryKillSwitch(),
      { write() {} },
      new InMemoryBrokerIdempotencyStore(),
      approvalStore,
    );

    const result = await broker.execute({
      intentId: decision.intentId,
      correlationId: decision.correlationId,
      outcome: "needs_human",
      intent: binanceSpotOrder,
      decidedAt: decision.decidedAt,
      approvalId,
      decisionToken: decision.decisionToken ?? "",
    });

    expect(decision.outcome).toBe("needs_human");
    expect(result.status).toBe("executed");
  });
});

describe("Hard-Deny Actions", () => {
  it("hard-deny never becomes human approval for withdrawal", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer("approve"),
      makeDenyPolicy("withdrawal", "Denied"),
      makeRisk(),
      nullAuditWriter,
    );
    const intent = { ...binanceSpotOrder, action: "cex.withdraw" as "cex.place_order" };
    const result = await svc.evaluate(intent);
    expect(result.outcome).toBe("deny");
    expect(result.requiresHumanApproval).toBe(false);
  });

  it("hard-deny never becomes human approval for transfer", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer("approve"),
      makeDenyPolicy("transfer", "Denied"),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate({
      ...binanceSpotOrder,
      action: "cex.account_transfer" as "cex.place_order",
    });
    expect(result.outcome).toBe("deny");
  });

  it("unauthorized withdrawal is denied", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeDenyPolicy("withdrawal_denied", "Not permitted"),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate(binanceSpotOrder);
    expect(result.outcome).toBe("deny");
  });

  it("unknown onchain contract is denied", async () => {
    const svc = new GuardrailService(
      { ...config, environment: "testnet" },
      makeReviewer(),
      makeOnchainHardDenyPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate({
      ...ethereumSepoliaSigning,
      to: "0x1111111111111111111111111111111111111111",
      resource: "onchain:ethereum:sepolia:0x1111111111111111111111111111111111111111",
      data: ERC20_APPROVAL_100,
      maxTokenApprovalAmount: "100",
    });
    expect(result.outcome).toBe("deny");
    expect(result.reasons[0].rule).toBe("unknown_contract_denied");
  });

  it("allowlisted contract with max approval is denied", async () => {
    const svc = new GuardrailService(
      { ...config, environment: "testnet" },
      makeReviewer(),
      makeOnchainHardDenyPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate({
      ...ethereumSepoliaSigning,
      data: ERC20_APPROVAL_MAX,
      maxTokenApprovalAmount: UINT256_MAX,
    });
    expect(result.outcome).toBe("deny");
    expect(result.reasons[0].rule).toBe("unlimited_approval_denied");
  });

  it("approval calldata without explicit metadata is denied", async () => {
    const svc = new GuardrailService(
      { ...config, environment: "testnet" },
      makeReviewer(),
      makeOnchainHardDenyPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate({ ...ethereumSepoliaSigning, data: ERC20_APPROVAL_100 });
    expect(result.outcome).toBe("deny");
    expect(result.reasons[0].rule).toBe("token_approval_amount_missing");
  });
});

describe("Fail-Closed Behavior", () => {
  it("OPA unavailable → deny", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      {
        async evaluate() {
          throw new Error("OPA down");
        },
        async isHealthy() {
          return false;
        },
      },
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate(binanceSpotOrder);
    expect(result.outcome).toBe("deny");
  });

  it("signer unavailable → broker rejects", async () => {
    const broker = new ExecutionBroker(
      brokerConfig,
      {
        async execute() {
          throw new Error("signer down");
        },
        async revalidate() {
          return { passed: true };
        },
      },
      new InMemoryKillSwitch(),
      { write() {} },
      new InMemoryBrokerIdempotencyStore(),
    );
    const result = await broker.execute({
      intentId: binanceSpotOrder.intentId,
      correlationId: "c",
      outcome: "allow",
      intent: binanceSpotOrder,
      decidedAt: now,
      decisionToken: decisionToken({
        intent: binanceSpotOrder,
        outcome: "allow",
        correlationId: "c",
      }),
    });
    expect(result.status).toBe("failed");
  });

  it("stale market data → risk check fails", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeAllowPolicy(),
      makeRisk(false),
      nullAuditWriter,
    );
    const result = await svc.evaluate(binanceSpotOrder);
    expect(result.outcome).toBe("deny");
  });

  it("malformed policy input → deny", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate({ action: "not_valid" });
    expect(result.outcome).toBe("deny");
  });
});

describe("Kill Switch", () => {
  it("global kill switch blocks broker execution", async () => {
    const ks = new InMemoryKillSwitch();
    ks.activate({ type: "global" });
    const broker = new ExecutionBroker(
      brokerConfig,
      new PaperExecutionConnector(),
      ks,
      { write() {} },
      new InMemoryBrokerIdempotencyStore(),
    );
    const result = await broker.execute({
      intentId: binanceSpotOrder.intentId,
      correlationId: "c",
      outcome: "allow",
      intent: binanceSpotOrder,
      decidedAt: now,
      decisionToken: decisionToken({
        intent: binanceSpotOrder,
        outcome: "allow",
        correlationId: "c",
      }),
    });
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("Kill switch");
  });

  it("per-agent kill switch blocks that agent", async () => {
    const ks = new InMemoryKillSwitch();
    ks.activate({ type: "agent", principal: binanceSpotOrder.principal });
    const broker = new ExecutionBroker(
      brokerConfig,
      new PaperExecutionConnector(),
      ks,
      { write() {} },
      new InMemoryBrokerIdempotencyStore(),
    );
    const result = await broker.execute({
      intentId: binanceSpotOrder.intentId,
      correlationId: "c",
      outcome: "allow",
      intent: binanceSpotOrder,
      decidedAt: now,
      decisionToken: decisionToken({
        intent: binanceSpotOrder,
        outcome: "allow",
        correlationId: "c",
      }),
    });
    expect(result.status).toBe("rejected");
  });
});

describe("Hallucinated Claims", () => {
  it("hallucinated price claim passes schema but evidence is required", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const intent = { ...binanceSpotOrder, rationale: hallucinatedClaims.fakePrice };
    const result = await svc.evaluate(intent);
    expect(result.outcome).toBe("deny");
    expect(result.reasons[0].rule).toBe("hallucinated_data_detected");
  });

  it("hallucinated balance claim is rejected", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const intent = { ...binanceSpotOrder, rationale: hallucinatedClaims.fakeBalance };
    const result = await svc.evaluate(intent);
    expect(result.outcome).toBe("deny");
    expect(result.reasons[0].rule).toBe("hallucinated_data_detected");
  });

  it("hallucinated position claim is rejected", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeAllowPolicy(),
      makeRisk(),
      nullAuditWriter,
    );
    const intent = { ...binanceSpotOrder, rationale: hallucinatedClaims.fakePosition };
    const result = await svc.evaluate(intent);
    expect(result.outcome).toBe("deny");
    expect(result.reasons[0].rule).toBe("hallucinated_data_detected");
  });
});
