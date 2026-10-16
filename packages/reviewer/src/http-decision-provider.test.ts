import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { DecisionRequest, HttpDecisionProviderConfig } from "./decision-provider.js";
import { HttpDecisionProvider } from "./http-decision-provider.js";

const secret = "decision-provider-secret-not-real";
const request: DecisionRequest = {
  input: "private trading intent",
  questions: [
    {
      id: "verdict",
      instructions: "Choose a recommendation.",
      choices: { approve: "Supported", reject: "Unsafe", needs_human: "Uncertain" },
    },
    {
      id: "riskLevel",
      instructions: "Classify risk.",
      choices: { low: "Limited", high: "Substantial" },
    },
  ],
};

function response() {
  return {
    model: "jev-1.13.0",
    answers: {
      verdict: {
        type: "choice",
        choice: "reject",
        confidence: 0.7,
        probabilities: { approve: 0.1, reject: 0.8, needs_human: 0.1 },
      },
      riskLevel: {
        type: "choice",
        choice: "high",
        confidence: 0.6,
        probabilities: { low: 0.2, high: 0.8 },
      },
    },
  };
}

function provider(provider: HttpDecisionProviderConfig["provider"] = "jev") {
  return new HttpDecisionProvider({
    provider,
    apiKey: secret,
    model: provider === "clef" ? "clef-flash" : provider === "jev" ? "jev-1.13.0" : "gpt-6-luna",
    accountId: "a".repeat(32),
  });
}

let body: unknown;
let status: number;
let fetchMock: Mock<() => Promise<Response>>;
beforeEach(() => {
  body = response();
  status = 200;
  fetchMock = vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("decision protocol normalization", () => {
  it("binds reordered OpenAI answers and probabilities by name rather than position", async () => {
    body = {
      model: "gpt-6-luna",
      answers: Object.entries(response().answers)
        .reverse()
        .map(([name, answer]) => ({
          ...answer,
          name,
          probabilities: Object.entries(answer.probabilities)
            .reverse()
            .map(([value, probability]) => ({
              value,
              probability,
            })),
        })),
    };
    const result = await provider("openai-decisions").decide(request);
    expect(result.answers.verdict).toEqual({
      choice: "reject",
      confidence: 0.7,
      probabilities: { approve: 0.1, reject: 0.8, needs_human: 0.1 },
    });
    expect(result.answers.riskLevel.choice).toBe("high");
  });

  it("requires the Cloudflare success envelope rather than accepting usable answers on failure", async () => {
    body = { success: false, errors: [{ message: secret }], result: response() };
    await expect(provider("clef").decide(request)).rejects.toThrow();
    body = { result: response() };
    await expect(provider("clef").decide(request)).rejects.toThrow();
    body = { success: true, result: response() };
    expect((await provider("clef").decide(request)).answers.verdict.choice).toBe("reject");
  });

  it.each([
    { type: "refusal", name: "verdict" },
    { ...response().answers.verdict, name: "wrong-question" },
  ])("rejects a refusal or unexpected OpenAI answer", async (answer) => {
    body = { model: "gpt-6-luna", answers: [answer] };
    await expect(provider("openai-decisions").decide(request)).rejects.toThrow();
  });

  it("rejects duplicated OpenAI answer names even if all required names are present", async () => {
    const answers = Object.entries(response().answers).map(([name, answer]) => ({
      ...answer,
      name,
      probabilities: Object.entries(answer.probabilities).map(([value, probability]) => ({
        value,
        probability,
      })),
    }));
    body = { model: "gpt-6-luna", answers: [...answers, answers[0]] };
    await expect(provider("openai-decisions").decide(request)).rejects.toThrow();
  });

  it.each<Record<string, unknown>>([
    { choice: "constructor" },
    { choice: "safe" },
    { type: "noul" },
    { confidence: null },
    { confidence: 1.01 },
    { probabilities: { approve: 1, reject: 0 } },
    { probabilities: { approve: -0.1, reject: 1, needs_human: 0.1 } },
    { probabilities: { approve: 0.1, reject: 0.8, needs_human: 0.1, constructor: 0 } },
  ])("rejects invalid classifications or distributions: %j", async (patch) => {
    const valid = response();
    body = {
      ...valid,
      answers: { ...valid.answers, verdict: { ...valid.answers.verdict, ...patch } },
    };
    await expect(provider().decide(request)).rejects.toThrow();
  });

  it("rejects partial answer coverage instead of assuming an absent risk is low", async () => {
    const valid = response();
    body = { ...valid, answers: { verdict: valid.answers.verdict } };
    await expect(provider().decide(request)).rejects.toThrow();
  });

  it("rejects duplicate request IDs before sending an ambiguous request", async () => {
    const question = request.questions[0];
    await expect(
      provider().decide({ ...request, questions: [question, question] }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("decision provider credential and failure boundaries", () => {
  it("does not expose credentials in inspection or serialization", () => {
    const client = provider();
    for (const visible of [
      JSON.stringify(client),
      inspect(client),
      inspect(client, { showHidden: true }),
      inspect(Object.getOwnPropertyDescriptors(client)),
    ])
      expect(visible).not.toContain(secret);
  });

  it.each([
    401, 429, 503,
  ])("fails closed on HTTP %i without leaking upstream content or retrying", async (code) => {
    status = code;
    body = { error: `${secret}: ${request.input}` };
    let error: unknown;
    try {
      await provider().decide(request);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error)).not.toContain(secret);
    expect(inspect(error)).not.toContain(request.input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes network failures and malformed JSON without leaking request data", async () => {
    fetchMock.mockRejectedValueOnce(new Error(`${secret}: ${request.input}`));
    let error: unknown;
    try {
      await provider().decide(request);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error)).not.toContain(secret);
    body = `${secret}: invalid json`;
    try {
      await provider().decide(request);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error)).not.toContain(secret);
  });

  it.each([
    { apiKey: " " },
    { model: " " },
    { baseUrl: "file:///etc" },
    { baseUrl: "https://user:secret@example.com" },
    { provider: "unknown" },
    { provider: "clef", model: "clef", accountId: "../accounts" },
    { provider: "clef", model: "clef", accountId: undefined },
    { provider: "clef", model: "clef/../other", accountId: "a".repeat(32) },
  ])("rejects invalid credentials, provider or endpoint configuration: %j", (patch) => {
    const config = { provider: "jev", apiKey: secret, model: "jev-1.13.0", ...patch };
    expect(() => new HttpDecisionProvider(config as HttpDecisionProviderConfig)).toThrow();
  });
});
