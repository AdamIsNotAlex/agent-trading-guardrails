import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { describe, expect, it } from "vitest";
import { ReviewerAdapter } from "./adapter.js";
import type { LlmProvider } from "./interfaces.js";
import { parseReviewerOutput } from "./parser.js";
import { buildReviewerPrompt } from "./prompt.js";

const validResponse = JSON.stringify({
  intentId: binanceSpotOrder.intentId,
  verdict: "approve",
  riskLevel: "low",
  reasons: ["Intent matches strategy parameters."],
  detectedIssues: [],
  requiredPolicyTags: ["cex.low_notional"],
  reviewerModel: "gpt-5.5",
  reviewerProvider: "openai",
  reviewedAt: "2026-05-04T12:00:01.000Z",
});

describe("buildReviewerPrompt", () => {
  it("includes intent data in prompt", () => {
    const prompt = buildReviewerPrompt(binanceSpotOrder);
    expect(prompt).toContain(binanceSpotOrder.intentId);
    expect(prompt).toContain("ADVISORY ONLY");
    expect(prompt).toContain("prompt_injection");
    expect(prompt).toContain("unsupported_claim");
    expect(prompt).toContain("evidence_action_mismatch");
  });
});

describe("parseReviewerOutput", () => {
  it("parses valid JSON response", () => {
    const result = parseReviewerOutput(validResponse);
    expect(result.verdict).toBe("approve");
    expect(result.intentId).toBe(binanceSpotOrder.intentId);
  });

  it("extracts JSON from surrounding text", () => {
    const wrapped = `Here is my review:\n${validResponse}\nEnd of review.`;
    const result = parseReviewerOutput(wrapped);
    expect(result.verdict).toBe("approve");
  });

  it("throws on empty response", () => {
    expect(() => parseReviewerOutput("")).toThrow("does not contain");
  });

  it("throws on non-JSON response", () => {
    expect(() => parseReviewerOutput("I think this trade looks good.")).toThrow("does not contain");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseReviewerOutput("{invalid json}")).toThrow("invalid JSON");
  });

  it("throws on malformed verdict schema", () => {
    const bad = JSON.stringify({ verdict: "maybe", riskLevel: "unknown" });
    expect(() => parseReviewerOutput(bad)).toThrow();
  });

  it("throws when missing required fields", () => {
    const partial = JSON.stringify({ verdict: "approve" });
    expect(() => parseReviewerOutput(partial)).toThrow();
  });

  it("parses response with detected issues", () => {
    const withIssues = JSON.stringify({
      intentId: binanceSpotOrder.intentId,
      verdict: "reject",
      riskLevel: "high",
      reasons: ["Suspicious rationale detected."],
      detectedIssues: ["prompt_injection", "unsupported_claim"],
      requiredPolicyTags: [],
      reviewerModel: "gpt-5.5",
      reviewerProvider: "openai",
      reviewedAt: "2026-05-04T12:00:01.000Z",
    });
    const result = parseReviewerOutput(withIssues);
    expect(result.verdict).toBe("reject");
    expect(result.detectedIssues).toContain("prompt_injection");
    expect(result.detectedIssues).toContain("unsupported_claim");
  });

  it("parses evidence_action_mismatch detection", () => {
    const mismatch = JSON.stringify({
      intentId: binanceSpotOrder.intentId,
      verdict: "needs_human",
      riskLevel: "medium",
      reasons: ["Evidence does not match action."],
      detectedIssues: ["evidence_action_mismatch"],
      requiredPolicyTags: [],
      reviewerModel: "gpt-5.5",
      reviewerProvider: "openai",
      reviewedAt: "2026-05-04T12:00:01.000Z",
    });
    const result = parseReviewerOutput(mismatch);
    expect(result.detectedIssues).toContain("evidence_action_mismatch");
  });
});

describe("ReviewerAdapter", () => {
  it("calls LLM and parses response", async () => {
    const llm: LlmProvider = {
      async complete() {
        return validResponse;
      },
    };
    const adapter = new ReviewerAdapter({ model: "gpt-5.5", provider: "openai" }, llm);
    const result = await adapter.review(binanceSpotOrder);
    expect(result.verdict).toBe("approve");
    expect(result.intentId).toBe(binanceSpotOrder.intentId);
  });

  it("fails closed when LLM returns garbage", async () => {
    const llm: LlmProvider = {
      async complete() {
        return "not json at all";
      },
    };
    const adapter = new ReviewerAdapter({ model: "gpt-5.5", provider: "openai" }, llm);
    await expect(adapter.review(binanceSpotOrder)).rejects.toThrow();
  });

  it("fails closed when LLM throws", async () => {
    const llm: LlmProvider = {
      async complete() {
        throw new Error("API error");
      },
    };
    const adapter = new ReviewerAdapter({ model: "gpt-5.5", provider: "openai" }, llm);
    await expect(adapter.review(binanceSpotOrder)).rejects.toThrow("API error");
  });

  it("verdict is advisory — adapter does not execute or sign", () => {
    const adapter = new ReviewerAdapter(
      { model: "gpt-5.5", provider: "openai" },
      {
        async complete() {
          return "";
        },
      },
    );
    expect(adapter).not.toHaveProperty("execute");
    expect(adapter).not.toHaveProperty("sign");
    expect(adapter).not.toHaveProperty("approve");
  });
});
