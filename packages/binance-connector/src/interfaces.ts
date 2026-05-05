export interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
  allowedAccounts: string[];
  allowedSpotSymbols: string[];
  allowedFuturesSymbols: string[];
  maxFuturesLeverage: number;
}

export interface BinanceMarketData {
  symbol: string;
  price: number;
  timestampMs: number;
}

export interface BinanceAccountSnapshot {
  account: string;
  balances: Array<{ asset: string; free: number; locked: number }>;
  positions: Array<{ symbol: string; quantity: number; notionalUsd: number; leverage: number }>;
  timestampMs: number;
}

export interface BinanceOrderResult {
  orderId: string;
  symbol: string;
  side: string;
  status: string;
  executedQty: number;
  avgPrice: number;
}

export interface BinanceApiClient {
  getPrice(symbol: string): Promise<BinanceMarketData>;
  getAccountSnapshot(account: string): Promise<BinanceAccountSnapshot>;
  placeSpotOrder(params: SpotOrderParams): Promise<BinanceOrderResult>;
  getFuturesMarginType(params: FuturesMarginTypeParams): Promise<"isolated" | "cross">;
  placeFuturesOrder(params: FuturesOrderParams): Promise<BinanceOrderResult>;
  cancelOrder(params: CancelOrderParams): Promise<BinanceOrderResult>;
  getOrderStatus(params: OrderStatusParams): Promise<BinanceOrderResult>;
}

export interface SpotOrderParams {
  account: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  quantity?: number;
  price?: number;
  clientOrderId?: string;
}

export interface FuturesMarginTypeParams {
  account: string;
  symbol: string;
}

export interface FuturesOrderParams {
  account: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  quantity?: number;
  price?: number;
  leverage: number;
  clientOrderId?: string;
}

export interface CancelOrderParams {
  account: string;
  symbol: string;
  orderId: string;
}

export interface OrderStatusParams {
  account: string;
  symbol: string;
  orderId: string;
}
