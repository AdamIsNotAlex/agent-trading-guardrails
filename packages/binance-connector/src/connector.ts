import type { ExecutionConnector } from "@guardrails/broker";
import type { TradingIntent } from "@guardrails/schemas";
import type { BinanceApiClient, BinanceConfig, OrderStatusParams } from "./interfaces.js";
import { BinancePaperSimulator } from "./paper-simulator.js";
import { rejectMarginModes, validateIntent } from "./validation.js";

export class BinanceConnector implements ExecutionConnector {
  private paper = new BinancePaperSimulator();

  constructor(
    private config: BinanceConfig,
    private client: BinanceApiClient | null,
    private mode: "paper" | "live",
  ) {}

  async revalidate(intent: TradingIntent): Promise<{ passed: boolean; reason?: string }> {
    const marginCheck = rejectMarginModes(intent);
    if (!marginCheck.valid) return { passed: false, reason: marginCheck.reason };

    const validation = validateIntent(intent, this.config);
    if (!validation.valid) return { passed: false, reason: validation.reason };

    if (this.mode === "live") {
      if (!this.client) return { passed: false, reason: "Binance API client not configured." };

      if (intent.action === "cex.place_order" && "symbol" in intent) {
        try {
          const marketData = await this.client.getPrice(intent.symbol);
          const ageMs = Date.now() - marketData.timestampMs;
          if (ageMs > 10_000) {
            return { passed: false, reason: `Market data is ${ageMs}ms old.` };
          }
        } catch {
          return { passed: false, reason: "Failed to fetch market data for revalidation." };
        }
      }
    }

    return { passed: true };
  }

  async execute(intent: TradingIntent): ReturnType<ExecutionConnector["execute"]> {
    if (intent.action === "cex.place_order" && "accountMode" in intent) {
      if (intent.accountMode === "spot") {
        return this.executeSpotOrder(intent);
      }
      if (intent.accountMode === "usdm_futures") {
        return this.executeFuturesOrder(intent);
      }
    }

    if (intent.action === "cex.cancel_order" && "orderId" in intent) {
      return this.executeCancelOrder(intent);
    }

    if (intent.action === "cex.get_order_status" && "orderId" in intent) {
      const orderStatus = await this.getOrderStatus({
        account: "account" in intent ? intent.account : "",
        symbol: "symbol" in intent ? intent.symbol : "",
        orderId: intent.orderId,
      });
      return { orderId: orderStatus.orderId, orderStatus };
    }

    return {};
  }

  private async executeSpotOrder(intent: TradingIntent): Promise<{ orderId?: string }> {
    if (!("symbol" in intent) || !("side" in intent) || !("orderType" in intent)) {
      throw new Error("Invalid spot order intent.");
    }

    const params = {
      account: "account" in intent ? intent.account : "",
      symbol: intent.symbol,
      side: (intent.side === "buy" ? "BUY" : "SELL") as "BUY" | "SELL",
      type: (intent.orderType === "limit" ? "LIMIT" : "MARKET") as "LIMIT" | "MARKET",
      quantity: "quantity" in intent ? intent.quantity : undefined,
      price: "price" in intent ? intent.price : undefined,
    };

    if (this.mode === "paper") {
      const result = this.paper.placeSpotOrder(params);
      return { orderId: result.orderId };
    }

    if (!this.client) throw new Error("Binance API client not configured for live mode.");
    const result = await this.client.placeSpotOrder(params);
    return { orderId: result.orderId };
  }

  private async executeFuturesOrder(intent: TradingIntent): Promise<{ orderId?: string }> {
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
      type: (intent.orderType === "limit" ? "LIMIT" : "MARKET") as "LIMIT" | "MARKET",
      quantity: "quantity" in intent ? intent.quantity : undefined,
      price: "price" in intent ? intent.price : undefined,
      leverage,
    };

    if (this.mode === "paper") {
      const result = this.paper.placeFuturesOrder(params);
      return { orderId: result.orderId };
    }

    if (!this.client) throw new Error("Binance API client not configured for live mode.");
    const result = await this.client.placeFuturesOrder(params);
    return { orderId: result.orderId };
  }

  private async executeCancelOrder(intent: TradingIntent): Promise<{ orderId?: string }> {
    if (!("orderId" in intent) || !("symbol" in intent) || !("account" in intent)) {
      throw new Error("Invalid cancel order intent.");
    }

    const params = {
      account: intent.account,
      symbol: intent.symbol,
      orderId: intent.orderId,
    };

    if (this.mode === "paper") {
      const result = this.paper.cancelOrder(params);
      return { orderId: result.orderId };
    }

    if (!this.client) throw new Error("Binance API client not configured for live mode.");
    const result = await this.client.cancelOrder(params);
    return { orderId: result.orderId };
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
