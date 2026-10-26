import type { BinanceAccountMode, BinanceApiClient, BinanceConfig } from "./interfaces.js";

// One key belongs to one dedicated account/product; account is a local alias, never a REST selector.
export interface BinanceRestConfig extends BinanceConfig {
  account: string;
}

export interface BinanceRestOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  recvWindowMs?: number;
}

export interface BinanceTrade {
  id: string;
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  quoteQuantity: number;
  price: number;
  commission: number;
  commissionAsset: string;
  timestampMs: number;
}

export interface BinanceHistoricalOrder {
  orderId: string;
  symbol: string;
  timestampMs: number;
}

export interface BinanceIncome {
  id: string;
  asset: string;
  income: number;
  incomeType: string;
  timestampMs: number;
}

export interface BinanceRiskHistory {
  account: string;
  date: string;
  timestampMs: number;
  // Spot: full available fill history from fromId=0 for cost basis, through timestampMs.
  // Futures: requested UTC day only. Never return truncated pages as complete history.
  trades: BinanceTrade[];
  orders: BinanceHistoricalOrder[];
  income: BinanceIncome[];
  lastOrderTimestampMs: number | null;
}

export interface BinanceRiskSource
  extends Pick<BinanceApiClient, "getPrice" | "getAccountSnapshot"> {
  readonly account: string;
  readonly accountMode: BinanceAccountMode;
  readonly historySymbols: readonly string[];
  getRiskHistory(account: string, date: string): Promise<BinanceRiskHistory>;
}
