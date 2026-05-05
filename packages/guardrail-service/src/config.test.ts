import { afterEach, describe, expect, it } from "vitest";
import { loadDevConfig } from "./config.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("loadDevConfig", () => {
  it("rejects Vault dev server in production", () => {
    process.env.GUARDRAIL_ENV = "production";
    process.env.VAULT_ADDR = "http://localhost:8200";

    expect(() => loadDevConfig()).toThrow("must use HTTPS");
  });

  it("rejects Vault dev server with normalized production environment", () => {
    process.env.GUARDRAIL_ENV = "PRODUCTION ";
    process.env.VAULT_ADDR = "http://localhost:8200";

    expect(() => loadDevConfig()).toThrow("must use HTTPS");
  });

  it("rejects invalid environment values", () => {
    process.env.GUARDRAIL_ENV = "prod";

    expect(() => loadDevConfig()).toThrow();
  });

  it("allows non-dev Vault in production", () => {
    process.env.GUARDRAIL_ENV = "production";
    process.env.VAULT_ADDR = "https://vault.example.com";

    expect(loadDevConfig().vaultAddr).toBe("https://vault.example.com");
  });
});
