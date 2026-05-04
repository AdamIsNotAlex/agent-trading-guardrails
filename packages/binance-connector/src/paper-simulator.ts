import { randomUUID } from "node:crypto";
import type {
  BinanceOrderResult,
  CancelOrderParams,
  FuturesOrderParams,
  SpotOrderParams,
} from "./interfaces.js";

export class BinancePaperSimulator {
  private orders = new Map<string, BinanceOrderResult>();

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
    return result;
  }

  cancelOrder(params: CancelOrderParams): BinanceOrderResult {
    const existing = this.orders.get(params.orderId);
    if (existing) {
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

  getOrderStatus(orderId: string): BinanceOrderResult | undefined {
    return this.orders.get(orderId);
  }
}
