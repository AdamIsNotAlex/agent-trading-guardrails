import { describe, expect, it } from "vitest";
import { loadReviewerRuntimeConfig } from "./reviewer-runtime.js";

const openai = { OPENAI_API_KEY: "sk-openai" };
const unused = {
  TYPESAFE_API_KEY: "ts-unused",
  CLOUDFLARE_API_TOKEN: "cf-unused",
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
};

describe("loadReviewerRuntimeConfig", () => {
  it("defaults to openai and selects only OPENAI_API_KEY", () => {
    expect(loadReviewerRuntimeConfig({ ...openai, ...unused })).toEqual({
      provider: "openai",
      apiKey: "sk-openai",
    });
  });

  it("selects OPENAI_API_KEY for openai-decisions rather than TypeSafe credentials", () => {
    expect(
      loadReviewerRuntimeConfig({
        ...openai,
        ...unused,
        REVIEWER_PROVIDER: "openai-decisions",
      }),
    ).toEqual({
      provider: "openai-decisions",
      apiKey: "sk-openai",
    });
  });

  it("selects only TypeSafe credentials for jev", () => {
    expect(
      loadReviewerRuntimeConfig({
        ...openai,
        ...unused,
        REVIEWER_PROVIDER: "jev",
      }),
    ).toEqual({
      provider: "jev",
      apiKey: "ts-unused",
    });
  });

  it("selects Cloudflare token and account id for clef", () => {
    expect(
      loadReviewerRuntimeConfig({
        ...openai,
        ...unused,
        REVIEWER_PROVIDER: "clef",
      }),
    ).toEqual({
      provider: "clef",
      apiKey: "cf-unused",
      accountId: "0123456789abcdef0123456789abcdef",
    });
  });

  it("rejects unknown, blank, or whitespace-only providers with no fallback", () => {
    expect(() =>
      loadReviewerRuntimeConfig({ ...openai, REVIEWER_PROVIDER: "anthropic" }),
    ).toThrow();
    expect(() => loadReviewerRuntimeConfig({ ...openai, REVIEWER_PROVIDER: "" })).toThrow();
    expect(() => loadReviewerRuntimeConfig({ ...openai, REVIEWER_PROVIDER: "  " })).toThrow();
  });

  it("rejects missing or whitespace-only credentials for the selected provider", () => {
    expect(() => loadReviewerRuntimeConfig({})).toThrow(/OPENAI_API_KEY/);
    expect(() => loadReviewerRuntimeConfig({ OPENAI_API_KEY: "  " })).toThrow(/OPENAI_API_KEY/);
    expect(() =>
      loadReviewerRuntimeConfig({ REVIEWER_PROVIDER: "jev", OPENAI_API_KEY: "sk-openai" }),
    ).toThrow(/TYPESAFE_API_KEY/);
    expect(() =>
      loadReviewerRuntimeConfig({
        REVIEWER_PROVIDER: "clef",
        CLOUDFLARE_API_TOKEN: "cf-token",
      }),
    ).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(() =>
      loadReviewerRuntimeConfig({
        REVIEWER_PROVIDER: "clef",
        CLOUDFLARE_API_TOKEN: "  ",
        CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      }),
    ).toThrow(/CLOUDFLARE_API_TOKEN/);
  });
});
