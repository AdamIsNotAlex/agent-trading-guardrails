import { readFileSync } from "node:fs";
import {
  BinanceConnector,
  BinanceRestClient,
  type BinanceRestConfig,
  BinanceRiskDataProvider,
} from "@guardrails/binance-connector";
import { type ExecutionConnector, PaperExecutionConnector } from "@guardrails/broker";
import { DEFAULT_CANARY_LIVE_LIMITS, RiskEngine } from "@guardrails/risk-engine";
import type { Environment } from "@guardrails/schemas";
import type { RiskEngine as ServiceRiskEngine } from "@guardrails/service";
import { createFileRiskEngine } from "./risk-snapshot.js";

function booleanSetting(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name] ?? String(fallback);
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false.`);
  return value === "true";
}

function credential(env: NodeJS.ProcessEnv, name: string): string {
  const path = env[`${name}_FILE`];
  if (path && env[name]) throw new Error(`Set only one of ${name} and ${name}_FILE.`);
  const value = (path ? readFileSync(path, "utf8") : env[name])?.trim();
  if (!value) throw new Error(`${name} or ${name}_FILE is required for Binance.`);
  return value;
}

function symbols(value: string | undefined, name: string): string[] {
  const result = value?.split(",").map((symbol) => symbol.trim()) ?? [];
  if (
    result.length === 0 ||
    result.some((symbol) => !/^[A-Z0-9]+-(USDT|USDC)$/.test(symbol)) ||
    new Set(result).size !== result.length
  ) {
    throw new Error(`${name} must contain unique comma-separated BASE-USDT or BASE-USDC symbols.`);
  }
  return result;
}

export function loadBinanceRestConfig(
  environment: Environment,
  env: NodeJS.ProcessEnv = process.env,
): BinanceRestConfig {
  const account = env.BINANCE_ACCOUNT?.trim();
  if (!account) throw new Error("BINANCE_ACCOUNT must name the dedicated Binance account.");
  const accountMode = env.BINANCE_ACCOUNT_MODE;
  if (accountMode !== "spot" && accountMode !== "usdm_futures") {
    throw new Error("BINANCE_ACCOUNT_MODE must be spot or usdm_futures.");
  }
  const testnet = booleanSetting(env, "BINANCE_TESTNET", true);
  if (
    (environment === "testnet" && !testnet) ||
    ((environment === "canary_live" || environment === "production") && testnet)
  ) {
    throw new Error("BINANCE_TESTNET does not match GUARDRAIL_ENV.");
  }
  const allowed = symbols(env.BINANCE_SYMBOLS, "BINANCE_SYMBOLS");
  const historySymbols = symbols(
    env.BINANCE_HISTORY_SYMBOLS ?? env.BINANCE_SYMBOLS,
    "BINANCE_HISTORY_SYMBOLS",
  );
  if (allowed.some((symbol) => !historySymbols.includes(symbol))) {
    throw new Error("BINANCE_HISTORY_SYMBOLS must cover every enabled trading symbol.");
  }
  const leverage = Number(env.BINANCE_MAX_FUTURES_LEVERAGE ?? "1");
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
    throw new Error("BINANCE_MAX_FUTURES_LEVERAGE must be an integer from 1 to 125.");
  }
  return {
    apiKey: credential(env, "BINANCE_API_KEY"),
    apiSecret: credential(env, "BINANCE_API_SECRET"),
    testnet,
    account,
    accountMode,
    allowedAccounts: [account],
    allowedSpotSymbols: accountMode === "spot" ? allowed : [],
    allowedFuturesSymbols: accountMode === "usdm_futures" ? allowed : [],
    historySymbols,
    maxFuturesLeverage: leverage,
  };
}

export function createRuntimeRiskEngine(environment: Environment): ServiceRiskEngine {
  const backend = process.env.RISK_DATA_PROVIDER ?? "file";
  if (backend === "file") {
    return createFileRiskEngine(process.env.RISK_DATA_PATH ?? "./data/risk/risk-snapshot.json");
  }
  if (backend !== "binance") throw new Error("RISK_DATA_PROVIDER must be file or binance.");
  const config = loadBinanceRestConfig(environment);
  const client = new BinanceRestClient(config);
  return {
    async evaluate(intent, verdict) {
      if ("account" in intent && intent.account !== config.account) {
        throw new Error("Risk account does not match the configured Binance credential.");
      }
      if ("accountMode" in intent && intent.accountMode !== config.accountMode) {
        throw new Error("Risk account mode does not match the configured Binance product.");
      }
      // A fresh provider pins facts within this evaluation, never across decisions.
      const engine = new RiskEngine(
        new BinanceRiskDataProvider(client),
        DEFAULT_CANARY_LIVE_LIMITS,
      );
      return engine.evaluate(intent, verdict);
    },
  };
}

export function createRuntimeConnector(environment: Environment): {
  connector: ExecutionConnector;
  executionMode: "paper" | "binance-testnet" | "binance-live";
  canaryLiveEnabled: boolean;
} {
  const backend = process.env.BROKER_CONNECTOR ?? "paper";
  if (backend === "paper") {
    if (environment !== "dev" && environment !== "paper") {
      throw new Error("The standalone paper broker requires GUARDRAIL_ENV=dev or paper.");
    }
    return {
      connector: new PaperExecutionConnector(),
      executionMode: "paper",
      canaryLiveEnabled: false,
    };
  }
  if (backend !== "binance") throw new Error("BROKER_CONNECTOR must be paper or binance.");
  if (environment !== "testnet" && environment !== "canary_live") {
    throw new Error("Binance execution requires GUARDRAIL_ENV=testnet or canary_live.");
  }
  const config = loadBinanceRestConfig(environment);
  return {
    connector: new BinanceConnector(config, new BinanceRestClient(config), "live"),
    executionMode: config.testnet ? "binance-testnet" : "binance-live",
    canaryLiveEnabled: booleanSetting(process.env, "BROKER_CANARY_LIVE_ENABLED", false),
  };
}
