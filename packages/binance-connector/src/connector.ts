import { createHash } from "node:crypto";
import {
  type BeforeConnectorSideEffect,
  ConnectorRevalidationError,
  type ExecutionConnector,
  scopeIdempotencyKey,
} from "@guardrails/broker";
import type { TradingIntent } from "@guardrails/schemas";
import type {
  BinanceApiClient,
  BinanceConfig,
  FuturesMarginTypeParams,
  OrderStatusParams,
} from "./interfaces.js";
import { BinancePaperSimulator } from "./paper-simulator.js";
import { rejectMarginModes, validateIntent } from "./validation.js";

export class BinanceConnector implements ExecutionConnector {
  private paper = new BinancePaperSimulator();

  constructor(
    private config: BinanceConfig,
    private client: BinanceApiClient | null,
    private mode: "paper" | "live",
  ) {}

  private validateExecutableIntent(intent: TradingIntent): void {
    const marginCheck = rejectMarginModes(intent);
    if (!marginCheck.valid) throw new Error(marginCheck.reason);

    const validation = validateIntent(intent, this.config);
    if (!validation.valid) throw new Error(validation.reason);

    if (intent.action === "cex.place_order") {
      if (intent.orderType !== "limit") {
        throw new Error("Only limit orders are supported.");
      }
      const notional = this.calculateOrderNotional(intent, intent.price);
      if (notional > intent.maxNotionalUsd) {
        throw new Error("Executable order notional exceeds approved maxNotionalUsd.");
      }
    }
  }

  private calculateOrderNotional(intent: TradingIntent, price: number | undefined): number {
    if (intent.action !== "cex.place_order") {
      return 0;
    }
    if (intent.quantity === undefined) {
      throw new Error("Executable order quantity is required.");
    }
    if (price === undefined) {
      throw new Error("Executable order price is required.");
    }
    if (!Number.isFinite(intent.quantity) || intent.quantity <= 0) {
      throw new Error("Executable order quantity is invalid.");
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Executable order price is invalid.");
    }
    return intent.quantity * price;
  }

  private async verifyFuturesIsolatedMargin(params: FuturesMarginTypeParams): Promise<void> {
    if (this.mode !== "live") return;
    if (!this.client) throw new Error("Binance API client not configured for live mode.");

    const marginType = await this.client.getFuturesMarginType(params);
    if (marginType !== "isolated") {
      throw new Error(`USD-M futures ${params.symbol} must be configured for isolated margin.`);
    }
  }

  async revalidate(intent: TradingIntent): Promise<{ passed: boolean; reason?: string }> {
    const marginCheck = rejectMarginModes(intent);
    if (!marginCheck.valid) return { passed: false, reason: marginCheck.reason };

    const validation = validateIntent(intent, this.config);
    if (!validation.valid) return { passed: false, reason: validation.reason };

    if (intent.action === "cex.place_order") {
      try {
        this.validateExecutableIntent(intent);
      } catch (err) {
        return {
          passed: false,
          reason: err instanceof Error ? err.message : "Executable order validation failed.",
        };
      }
    }

    if (this.mode === "live") {
      if (!this.client) return { passed: false, reason: "Binance API client not configured." };

      if (intent.action === "cex.place_order" && intent.accountMode === "usdm_futures") {
        try {
          await this.verifyFuturesIsolatedMargin({
            account: intent.account,
            symbol: intent.symbol,
          });
        } catch (err) {
          return {
            passed: false,
            reason: err instanceof Error ? err.message : "Failed to verify futures margin type.",
          };
        }
      }

      if (intent.action === "cex.place_order" && "symbol" in intent) {
        try {
          const marketData = await this.client.getPrice(intent.symbol);
          const ageMs = Date.now() - marketData.timestampMs;
          if (!Number.isFinite(marketData.timestampMs) || !Number.isFinite(ageMs) || ageMs < 0) {
            return { passed: false, reason: "Market data timestamp is invalid." };
          }
          if (!Number.isFinite(marketData.price) || marketData.price <= 0) {
            return { passed: false, reason: "Market data price is invalid." };
          }
          if (ageMs > 10_000) {
            return { passed: false, reason: `Market data is ${ageMs}ms old.` };
          }
          const deviationBps =
            Math.abs((intent.price - marketData.price) / marketData.price) * 10_000;
          if (deviationBps > intent.maxSlippageBps) {
            return {
              passed: false,
              reason: `Market price deviation ${deviationBps.toFixed(1)}bps exceeds approved slippage.`,
            };
          }
          const notional = this.calculateOrderNotional(intent, intent.price);
          if (notional > intent.maxNotionalUsd) {
            return {
              passed: false,
              reason: "Executable order notional exceeds approved maxNotionalUsd.",
            };
          }
        } catch {
          return { passed: false, reason: "Failed to fetch market data for revalidation." };
        }
      }
    }

    return { passed: true };
  }

  async execute(
    intent: TradingIntent,
    beforeSideEffect?: BeforeConnectorSideEffect,
  ): ReturnType<ExecutionConnector["execute"]> {
    const validation = await this.revalidate(intent);
    if (!validation.passed) {
      throw new ConnectorRevalidationError(
        validation.reason ?? "Binance connector revalidation failed.",
      );
    }

    if (intent.action === "cex.place_order" && "accountMode" in intent) {
      if (intent.orderType !== "limit") {
        throw new Error("Only limit orders are supported.");
      }
      if (intent.accountMode === "spot") {
        return this.executeSpotOrder(intent, beforeSideEffect);
      }
      if (intent.accountMode === "usdm_futures") {
        return this.executeFuturesOrder(intent, beforeSideEffect);
      }
    }

    if (intent.action === "cex.cancel_order" && "orderId" in intent) {
      return this.executeCancelOrder(intent, beforeSideEffect);
    }

    if (intent.action === "cex.get_order_status" && "orderId" in intent) {
      const orderStatus = await this.getOrderStatus({
        account: "account" in intent ? intent.account : "",
        symbol: "symbol" in intent ? intent.symbol : "",
        orderId: intent.orderId,
      });
      return { orderId: orderStatus.orderId, orderStatus };
    }

    throw new Error(`Binance connector does not execute ${intent.action}.`);
  }

  private async executeSpotOrder(
    intent: TradingIntent,
    beforeSideEffect?: BeforeConnectorSideEffect,
  ): ReturnType<ExecutionConnector["execute"]> {
    if (!("symbol" in intent) || !("side" in intent) || !("orderType" in intent)) {
      throw new Error("Invalid spot order intent.");
    }

    const params = {
      account: "account" in intent ? intent.account : "",
      symbol: intent.symbol,
      side: (intent.side === "buy" ? "BUY" : "SELL") as "BUY" | "SELL",
      type: "LIMIT" as "LIMIT" | "MARKET",
      quantity: "quantity" in intent ? intent.quantity : undefined,
      price: "price" in intent ? intent.price : undefined,
      clientOrderId: this.clientOrderId(intent),
    };

    if (this.mode === "paper") {
      beforeSideEffect?.();
      const result = this.paper.placeSpotOrder(params);
      return { orderId: result.orderId };
    }

    if (!this.client) throw new Error("Binance API client not configured for live mode.");
    beforeSideEffect?.();
    const result = await this.client.placeSpotOrder(params);
    return { orderId: result.orderId };
  }

  private async executeFuturesOrder(
    intent: TradingIntent,
    beforeSideEffect?: BeforeConnectorSideEffect,
  ): ReturnType<ExecutionConnector["execute"]> {
    if (!("symbol" in intent) || !("side" in intent) || !("orderType" in intent)) {
      throw new Error("Invalid futures order intent.");
    }

    const leverage = "leverage" in intent && intent.leverage != null ? intent.leverage : 1;

    if (leverage > this.config.maxFuturesLeverage) {
      throw new Error(`Leverage ${leverage}x exceeds max ${this.config.maxFuturesLeverage}x.`);
    }

    const params = {
      account: "account" in intent ? intent.account : "",
      symbol: intent.symbol,
      side: (intent.side === "buy" ? "BUY" : "SELL") as "BUY" | "SELL",
      type: "LIMIT" as "LIMIT" | "MARKET",
      quantity: "quantity" in intent ? intent.quantity : undefined,
      price: "price" in intent ? intent.price : undefined,
      leverage,
      clientOrderId: this.clientOrderId(intent),
    };

    if (this.mode === "paper") {
      beforeSideEffect?.();
      const result = this.paper.placeFuturesOrder(params);
      return { orderId: result.orderId };
    }

    if (!this.client) throw new Error("Binance API client not configured for live mode.");
    await this.verifyFuturesIsolatedMargin({ account: params.account, symbol: params.symbol });
    beforeSideEffect?.();
    const result = await this.client.placeFuturesOrder(params);
    return { orderId: result.orderId };
  }

  private async executeCancelOrder(
    intent: TradingIntent,
    beforeSideEffect?: BeforeConnectorSideEffect,
  ): ReturnType<ExecutionConnector["execute"]> {
    if (!("orderId" in intent) || !("symbol" in intent) || !("account" in intent)) {
      throw new Error("Invalid cancel order intent.");
    }

    const params = {
      account: intent.account,
      symbol: intent.symbol,
      orderId: intent.orderId,
    };

    if (this.mode === "paper") {
      beforeSideEffect?.();
      const result = this.paper.cancelOrder(params);
      return { orderId: result.orderId };
    }

    if (!this.client) throw new Error("Binance API client not configured for live mode.");
    beforeSideEffect?.();
    const result = await this.client.cancelOrder(params);
    return { orderId: result.orderId };
  }

  private clientOrderId(intent: TradingIntent): string {
    const scopedKey = scopeIdempotencyKey(intent.idempotencyKey, intent);
    return `guardrails-${createHash("sha256").update(scopedKey).digest("hex").slice(0, 24)}`;
  }

  async getMarketData(symbol: string) {
    if (this.mode === "paper") {
      return { symbol, price: 0, timestampMs: Date.now() };
    }
    if (!this.client) throw new Error("Binance API client not configured.");
    return this.client.getPrice(symbol);
  }

  async getAccountSnapshot(account: string) {
    if (this.mode === "paper") {
      return { account, balances: [], positions: [], timestampMs: Date.now() };
    }
    if (!this.client) throw new Error("Binance API client not configured.");
    return this.client.getAccountSnapshot(account);
  }

  async getOrderStatus(params: OrderStatusParams) {
    if (this.mode === "paper") {
      return this.paper.getOrderStatus(params);
    }
    if (!this.client) throw new Error("Binance API client not configured.");
    return this.client.getOrderStatus(params);
  }
}
