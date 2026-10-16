import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { describe, expect, it } from "vitest";
import type { ChoiceAnswer, DecisionResult } from "./decision-provider.js";
import { DecisionReviewerAdapter } from "./decision-reviewer.js";

function answer(choice: string): ChoiceAnswer {
  return { choice, confidence: 1, probabilities: { [choice]: 1 } };
}

function result(): DecisionResult {
  return {
    model: "jev-1.13.0",
    answers: {
      verdict: answer("approve"),
      riskLevel: answer("low"),
      issue_prompt_injection: answer("absent"),
      issue_unsupported_claim: answer("absent"),
      issue_evidence_action_mismatch: answer("absent"),
      issue_suspicious_tool_behavior: answer("absent"),
      issue_hallucinated_data: answer("absent"),
      issue_excessive_risk: answer("absent"),
    },
  };
}

function reviewer(response: DecisionResult) {
  return new DecisionReviewerAdapter(
    { provider: "jev", model: "jev-latest" },
    {
      async decide() {
        return response;
      },
    },
  );
}

describe("decision reviewer safety mapping", () => {
  it("retains every detected issue even when the verdict contradictorily approves", async () => {
    const response = result();
    const review = await reviewer({
      ...response,
      answers: {
        ...response.answers,
        issue_prompt_injection: answer("present"),
        issue_evidence_action_mismatch: answer("present"),
      },
    }).review(binanceSpotOrder);
    // The existing risk-engine consistency check must receive this contradiction, not an allow.
    expect(review.verdict).toBe("approve");
    expect(review.detectedIssues).toEqual(["prompt_injection", "evidence_action_mismatch"]);
  });

  it("does not downgrade a critical risk because the recommendation is approve", async () => {
    const response = result();
    const review = await reviewer({
      ...response,
      answers: { ...response.answers, riskLevel: answer("critical") },
    }).review(binanceSpotOrder);
    expect(review).toMatchObject({ verdict: "approve", riskLevel: "critical" });
  });

  it.each([
    "riskLevel",
    "issue_prompt_injection",
  ])("rejects a missing %s instead of assuming a safe classification", async (key) => {
    const response = result();
    const answers = { ...response.answers };
    delete answers[key];
    await expect(reviewer({ ...response, answers }).review(binanceSpotOrder)).rejects.toThrow();
  });

  it.each(["constructor", "safe", ""])("rejects an unsupported risk label %j", async (label) => {
    const response = result();
    await expect(
      reviewer({
        ...response,
        answers: { ...response.answers, riskLevel: answer(label) },
      }).review(binanceSpotOrder),
    ).rejects.toThrow();
  });

  it("rejects an unexpected answer replacing a required issue", async () => {
    const response = result();
    const answers = { ...response.answers };
    delete answers.issue_excessive_risk;
    answers.unrelated = answer("absent");
    await expect(reviewer({ ...response, answers }).review(binanceSpotOrder)).rejects.toThrow();
  });
});
