export interface MarketDataSnapshot {
  symbol: string;
  price: number;
  timestampMs: number;
}

export interface PortfolioSnapshot {
  account: string;
  timestampMs: number;
  positions: Array<{ symbol: string; quantity: number; notionalUsd: number }>;
}

export interface DailyStats {
  account: string;
  date: string;
  totalNotionalUsd: number;
  realizedLossUsd: number;
  orderCount: number;
}

export interface RiskDataProvider {
  getMarketData(symbol: string): Promise<MarketDataSnapshot | null>;
  getPortfolio(account: string): Promise<PortfolioSnapshot | null>;
  getDailyStats(account: string, date: string): Promise<DailyStats | null>;
  getLastOrderTimestampMs(account: string): Promise<number | null>;
}
