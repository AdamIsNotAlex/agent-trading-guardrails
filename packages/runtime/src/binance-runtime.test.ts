import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeConnector,
  createRuntimeRiskEngine,
  loadBinanceRestConfig,
} from "./binance-runtime.js";

const settings = {
  BINANCE_ACCOUNT: "subaccount-1",
  BINANCE_ACCOUNT_MODE: "spot",
  BINANCE_SYMBOLS: "ETH-USDC",
  BINANCE_HISTORY_SYMBOLS: "ETH-USDC",
  BINANCE_API_KEY: "fixture-key",
  BINANCE_API_SECRET: "fixture-secret",
  BINANCE_TESTNET: "true",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Binance runtime safety boundaries", () => {
  it("rejects exchange/environment mismatches instead of routing testnet approval to mainnet", () => {
    expect(() =>
      loadBinanceRestConfig("testnet", { ...settings, BINANCE_TESTNET: "false" }),
    ).toThrow();
    expect(() => loadBinanceRestConfig("canary_live", settings)).toThrow();
    expect(() =>
      loadBinanceRestConfig("testnet", { ...settings, BINANCE_TESTNET: "yes" }),
    ).toThrow();
  });

  it("requires a complete configured history universe for enabled trading symbols", () => {
    expect(() =>
      loadBinanceRestConfig("testnet", { ...settings, BINANCE_HISTORY_SYMBOLS: "BTC-USDT" }),
    ).toThrow();
    expect(() =>
      loadBinanceRestConfig("testnet", { ...settings, BINANCE_SYMBOLS: "ETH-USDC,ETH-USDC" }),
    ).toThrow();
  });

  it("never starts real exchange execution under paper/dev or reserved production profiles", () => {
    for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
    vi.stubEnv("BROKER_CONNECTOR", "binance");
    for (const environment of ["dev", "paper", "production"] as const) {
      expect(() => createRuntimeConnector(environment)).toThrow();
    }
  });

  it("rejects unknown backend selectors rather than silently using paper or file fallbacks", () => {
    vi.stubEnv("BROKER_CONNECTOR", "biance");
    vi.stubEnv("RISK_DATA_PROVIDER", "biance");
    expect(() => createRuntimeConnector("dev")).toThrow();
    expect(() => createRuntimeRiskEngine("dev")).toThrow();
  });

  it("rejects account and market rebinding before any credential-bearing request", async () => {
    for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
    vi.stubEnv("RISK_DATA_PROVIDER", "binance");
    let outbound = 0;
    vi.stubGlobal("fetch", async () => {
      outbound++;
      throw new Error("Unexpected exchange request.");
    });
    const engine = createRuntimeRiskEngine("testnet");
    const verdict = {
      intentId: binanceSpotOrder.intentId,
      verdict: "approve" as const,
      riskLevel: "low" as const,
      reasons: ["Evidence reviewed."],
      detectedIssues: [],
      requiredPolicyTags: [],
      reviewerModel: "test",
      reviewerProvider: "test",
      reviewedAt: new Date().toISOString(),
    };
    await expect(
      engine.evaluate({ ...binanceSpotOrder, account: "unbound-account" }, verdict),
    ).rejects.toThrow();
    await expect(
      engine.evaluate({ ...binanceSpotOrder, accountMode: "usdm_futures" }, verdict),
    ).rejects.toThrow();
    expect(outbound).toBe(0);
  });

  it("leaves testnet IP allowlists empty and requires literal IPs for canary live", () => {
    expect(loadBinanceRestConfig("testnet", settings).ipAllowlist).toEqual([]);
    expect(
      loadBinanceRestConfig("testnet", { ...settings, BINANCE_IP_ALLOWLIST: "203.0.113.10" })
        .ipAllowlist,
    ).toEqual([]);
    expect(() =>
      loadBinanceRestConfig("canary_live", { ...settings, BINANCE_TESTNET: "false" }),
    ).toThrow("BINANCE_IP_ALLOWLIST is required for live Binance credentials.");
    expect(() =>
      loadBinanceRestConfig("canary_live", {
        ...settings,
        BINANCE_TESTNET: "false",
        BINANCE_IP_ALLOWLIST: "0.0.0.0",
      }),
    ).toThrow("wildcard");
    expect(() =>
      loadBinanceRestConfig("canary_live", {
        ...settings,
        BINANCE_TESTNET: "false",
        BINANCE_IP_ALLOWLIST: "203.0.113.10,203.0.113.10",
      }),
    ).toThrow("unique");
    expect(() =>
      loadBinanceRestConfig("canary_live", {
        ...settings,
        BINANCE_TESTNET: "false",
        BINANCE_IP_ALLOWLIST: "203.0.113.10,",
      }),
    ).toThrow("unique comma-separated");
    expect(
      loadBinanceRestConfig("canary_live", {
        ...settings,
        BINANCE_TESTNET: "false",
        BINANCE_IP_ALLOWLIST: "203.0.113.10,2001:db8::1",
      }).ipAllowlist,
    ).toEqual(["203.0.113.10", "2001:db8::1"]);
  });
});
