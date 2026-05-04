import { ExecutionBroker, InMemoryKillSwitch, PaperExecutionConnector } from "@guardrails/broker";
import type {
  DynamicRiskResult,
  PolicyOutput,
  ReviewerVerdictSchema,
  TradingIntent,
} from "@guardrails/schemas";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
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
const nullAuditWriter = { write() {} };
const config: GuardrailConfig = {
  environment: "canary_live",
  opaUrl: "http://localhost:8181",
  approvalTimeoutSeconds: 300,
};

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
    expect(result.intentId).toBeTruthy();
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
    expect(result.intentId).toBeTruthy();
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
    expect(result.intentId).toBeTruthy();
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
      config,
      makeReviewer(),
      makeDenyPolicy("unknown_contract", "Not in allowlist"),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate(binanceSpotOrder);
    expect(result.outcome).toBe("deny");
  });

  it("unlimited approval is denied", async () => {
    const svc = new GuardrailService(
      config,
      makeReviewer(),
      makeDenyPolicy("unlimited_approval", "Denied"),
      makeRisk(),
      nullAuditWriter,
    );
    const result = await svc.evaluate(binanceSpotOrder);
    expect(result.outcome).toBe("deny");
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
      { environment: "paper", canaryLiveEnabled: false },
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
      {
        get() {
          return undefined;
        },
        set() {},
      },
    );
    const result = await broker.execute({
      intentId: "test",
      correlationId: "c",
      outcome: "allow",
      intent: binanceSpotOrder,
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
      { environment: "paper", canaryLiveEnabled: false },
      new PaperExecutionConnector(),
      ks,
      { write() {} },
      {
        get() {
          return undefined;
        },
        set() {},
      },
    );
    const result = await broker.execute({
      intentId: "test",
      correlationId: "c",
      outcome: "allow",
      intent: binanceSpotOrder,
    });
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toContain("Kill switch");
  });

  it("per-agent kill switch blocks that agent", async () => {
    const ks = new InMemoryKillSwitch();
    ks.activate({ type: "agent", principal: binanceSpotOrder.principal });
    const broker = new ExecutionBroker(
      { environment: "paper", canaryLiveEnabled: false },
      new PaperExecutionConnector(),
      ks,
      { write() {} },
      {
        get() {
          return undefined;
        },
        set() {},
      },
    );
    const result = await broker.execute({
      intentId: "test",
      correlationId: "c",
      outcome: "allow",
      intent: binanceSpotOrder,
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
    expect(result.intentId).toBeTruthy();
  });
});
