import { randomUUID } from "node:crypto";
import type {
  BinanceOrderResult,
  CancelOrderParams,
  FuturesOrderParams,
  OrderStatusParams,
  SpotOrderParams,
} from "./interfaces.js";

export class BinancePaperSimulator {
  private orders = new Map<string, BinanceOrderResult>();
  private orderAccounts = new Map<string, string>();

  placeSpotOrder(params: SpotOrderParams): BinanceOrderResult {
    const orderId = `paper-spot-${randomUUID().slice(0, 8)}`;
    const result: BinanceOrderResult = {
      orderId,
      symbol: params.symbol,
      side: params.side,
      status: "FILLED",
      executedQty: params.quantity ?? 0,
      avgPrice: params.price ?? 0,
    };
    this.orders.set(orderId, result);
    this.orderAccounts.set(orderId, params.account);
    return result;
  }

  placeFuturesOrder(params: FuturesOrderParams): BinanceOrderResult {
    const orderId = `paper-futures-${randomUUID().slice(0, 8)}`;
    const result: BinanceOrderResult = {
      orderId,
      symbol: params.symbol,
      side: params.side,
      status: "FILLED",
      executedQty: params.quantity ?? 0,
      avgPrice: params.price ?? 0,
    };
    this.orders.set(orderId, result);
    this.orderAccounts.set(orderId, params.account);
    return result;
  }

  cancelOrder(params: CancelOrderParams): BinanceOrderResult {
    const existing = this.orders.get(params.orderId);
    if (existing) {
      if (
        this.orderAccounts.get(params.orderId) !== params.account ||
        existing.symbol !== params.symbol
      ) {
        throw new Error(`Order ${params.orderId} was not found for account and symbol.`);
      }
      existing.status = "CANCELED";
      return existing;
    }
    return {
      orderId: params.orderId,
      symbol: params.symbol,
      side: "BUY",
      status: "CANCELED",
      executedQty: 0,
      avgPrice: 0,
    };
  }

  getOrderStatus(params: OrderStatusParams): BinanceOrderResult {
    const existing = this.orders.get(params.orderId);
    if (!existing) {
      throw new Error(`Order ${params.orderId} was not found.`);
    }
    if (this.orderAccounts.get(params.orderId) !== params.account) {
      throw new Error(`Order ${params.orderId} was not found for account ${params.account}.`);
    }
    if (existing.symbol !== params.symbol) {
      throw new Error(`Order ${params.orderId} was not found for symbol ${params.symbol}.`);
    }
    return existing;
  }
}
