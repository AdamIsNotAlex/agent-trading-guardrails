import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiLlmProvider } from "./openai-provider.js";

let responseStatus: number;
let responseBody: unknown;
let originalFetch: typeof globalThis.fetch;
const requests: Array<{ url: string; body: unknown; authorization: string | undefined }> = [];

const reviewerJson = {
  intentId: "550e8400-e29b-41d4-a716-446655440000",
  verdict: "approve",
  riskLevel: "low",
  reasons: ["Intent is consistent with evidence."],
  detectedIssues: [],
  requiredPolicyTags: ["cex_spot"],
  reviewerModel: "gpt-5.5",
  reviewerProvider: "openai",
  reviewedAt: "2026-05-04T00:00:00.000Z",
};

function headerValue(
  headers: RequestInit["headers"] | undefined,
  name: string,
): string | undefined {
  return new Headers(headers).get(name) ?? undefined;
}

beforeEach(() => {
  requests.length = 0;
  responseStatus = 200;
  responseBody = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "gpt-5.5",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(reviewerJson) },
        finish_reason: "stop",
      },
    ],
  };

  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push({
      url,
      body: init?.body ? JSON.parse(init.body.toString()) : null,
      authorization: headerValue(init?.headers, "authorization"),
    });
    return new Response(JSON.stringify(responseBody), {
      status: responseStatus,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OpenAiLlmProvider", () => {
  it("calls OpenAI chat completions with the configured model and API key", async () => {
    const provider = new OpenAiLlmProvider({ apiKey: "sk-test-secret", model: "gpt-4.1" });

    const raw = await provider.complete("review this intent");

    expect(JSON.parse(raw)).toEqual(reviewerJson);
    expect(requests[0]).toMatchObject({
      url: "https://api.openai.com/v1/chat/completions",
      authorization: "Bearer sk-test-secret",
      body: {
        model: "gpt-4.1",
        messages: [{ role: "user", content: "review this intent" }],
      },
    });
  });

  it("does not expose client internals or API key through object inspection", () => {
    const provider = new OpenAiLlmProvider({ apiKey: "sk-test-secret" });
    const inspected = inspect(provider);
    const hiddenInspection = inspect(provider, { showHidden: true });
    const descriptors = inspect(Object.getOwnPropertyDescriptors(provider));

    expect(JSON.stringify(provider)).not.toContain("sk-test-secret");
    expect(inspected).not.toContain("sk-test-secret");
    expect(hiddenInspection).not.toContain("sk-test-secret");
    expect(descriptors).not.toContain("sk-test-secret");
  });

  it("does not include the API key in provider errors", async () => {
    responseStatus = 500;
    responseBody = { error: { message: "upstream failed with Bearer sk-test-secret" } };
    const provider = new OpenAiLlmProvider({ apiKey: "sk-test-secret" });

    let thrown: unknown;
    try {
      await provider.complete("review this intent");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(inspect(thrown)).not.toContain("sk-test-secret");
    expect(inspect(thrown)).not.toContain("Bearer sk-test-secret");
  });

  it("requires an API key", () => {
    expect(() => new OpenAiLlmProvider({ apiKey: "" })).toThrow("API key");
    expect(() => new OpenAiLlmProvider({ apiKey: "   " })).toThrow("API key");
  });
});
