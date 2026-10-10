import {
  binanceCancelOrder,
  binanceFuturesOrder,
  binanceOrderStatus,
  binanceSpotOrder,
} from "@guardrails/schemas/fixtures";
import { describe, expect, it } from "vitest";
import type { BinanceApiKeyPermissions, BinanceConfig } from "./interfaces.js";
import {
  validateIpAllowlist,
  validateIpRestriction,
  validateLiveKeyPermissions,
  validateNoWithdrawalKey,
} from "./validation.js";

const config: BinanceConfig = {
  apiKey: "test-key",
  apiSecret: "test-secret",
  testnet: false,
  allowedAccounts: ["subaccount-1", "subaccount-2"],
  allowedSpotSymbols: ["ETH-USDC", "BTC-USDC"],
  allowedFuturesSymbols: ["BTC-USDT", "ETH-USDT"],
  maxFuturesLeverage: 3,
  ipAllowlist: ["203.0.113.10"],
};
const safePermissions: BinanceApiKeyPermissions = {
  ipRestrict: true,
  enableWithdrawals: false,
  enableReading: true,
  enableSpotAndMarginTrading: true,
  enableFutures: true,
};

describe("IP allowlist", () => {
  it("accepts concrete IPv4 and IPv6 addresses", () => {
    expect(validateIpAllowlist(["203.0.113.10", "2001:db8::1"]).valid).toBe(true);
  });

  it.each([
    [],
    ["203.0.113.10", "203.0.113.10"],
    ["2001:db8::1", "2001:0DB8:0:0:0:0:0:1"],
    ["203.0.113.0/24"],
    ["*"],
    ["0.0.0.0"],
    ["::"],
    ["0::"],
    ["0:0:0:0:0:0:0:0"],
    ["::ffff:0.0.0.0"],
    ["0:0:0:0:0:ffff:0:0"],
    ["fe80::1%eth0"],
  ])("rejects unspecified, ambiguous or nonliteral addresses: %j", (...addresses) => {
    expect(validateIpAllowlist(addresses).valid).toBe(false);
  });
});

describe("live key permissions", () => {
  it.each([
    true,
    undefined,
    "false",
  ])("never assumes missing or invalid withdrawals are disabled (%s)", (flag) => {
    const permissions = {
      ...safePermissions,
      enableWithdrawals: flag,
    } as unknown as BinanceApiKeyPermissions;
    expect(validateNoWithdrawalKey(permissions).valid).toBe(false);
  });

  it.each([false, undefined, "true"])("requires an affirmative IP restriction (%s)", (flag) => {
    const permissions = {
      ...safePermissions,
      ipRestrict: flag,
    } as unknown as BinanceApiKeyPermissions;
    expect(validateIpRestriction(permissions).valid).toBe(false);
  });

  it("requires reading for placement/status but does not prevent cancellation with a trading-only key", () => {
    const unread = { ...safePermissions, enableReading: false };
    expect(validateLiveKeyPermissions(unread, binanceSpotOrder, config).valid).toBe(false);
    expect(validateLiveKeyPermissions(unread, binanceOrderStatus, config).valid).toBe(false);
    expect(validateLiveKeyPermissions(unread, binanceCancelOrder, config).valid).toBe(true);
    expect(validateLiveKeyPermissions(safePermissions, binanceSpotOrder, config).valid).toBe(true);
  });

  it("requires the trading permission for the configured order product", () => {
    const spotOnly = { ...safePermissions, enableFutures: false };
    const futuresOnly = { ...safePermissions, enableSpotAndMarginTrading: false };
    expect(validateLiveKeyPermissions(spotOnly, binanceFuturesOrder, config).valid).toBe(false);
    expect(validateLiveKeyPermissions(futuresOnly, binanceSpotOrder, config).valid).toBe(false);
    expect(validateLiveKeyPermissions(spotOnly, binanceSpotOrder, config).valid).toBe(true);
    expect(validateLiveKeyPermissions(futuresOnly, binanceFuturesOrder, config).valid).toBe(true);
    expect(validateLiveKeyPermissions(futuresOnly, binanceCancelOrder, config).valid).toBe(false);
    expect(
      validateLiveKeyPermissions(futuresOnly, { ...binanceCancelOrder, symbol: "BTC-USDT" }, config)
        .valid,
    ).toBe(true);
  });

  it("does not grant ambiguous cancellation a permission from the wrong product", () => {
    const both = {
      ...config,
      allowedSpotSymbols: ["BTC-USDT"],
      allowedFuturesSymbols: ["BTC-USDT"],
    };
    const intent = { ...binanceCancelOrder, symbol: "BTC-USDT" };
    expect(
      validateLiveKeyPermissions(
        { ...safePermissions, enableSpotAndMarginTrading: false },
        intent,
        both,
      ).valid,
    ).toBe(false);
    expect(
      validateLiveKeyPermissions({ ...safePermissions, enableFutures: false }, intent, both).valid,
    ).toBe(false);
  });
});
