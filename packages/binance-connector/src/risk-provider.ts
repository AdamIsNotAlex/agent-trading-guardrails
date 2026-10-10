import type {
  DailyStats,
  MarketDataSnapshot,
  PortfolioSnapshot,
  RiskDataProvider,
} from "@guardrails/risk-engine";
import type { BinanceAccountSnapshot } from "./interfaces.js";
import type { BinanceRiskHistory, BinanceRiskSource, BinanceTrade } from "./rest-types.js";

const STABLE_ASSETS: Record<string, true> = { USDT: true, USDC: true };
const TRANSFER_TYPES: Record<string, true> = { TRANSFER: true, INTERNAL_TRANSFER: true };
const MAX_COLLECTION_AGE_MS = 30_000;

function finite(value: number, minimum = Number.NEGATIVE_INFINITY): number {
  if (!Number.isFinite(value) || value < minimum) throw new Error("Invalid Binance risk number.");
  return value;
}
function positive(value: number): number {
  if (finite(value, 0) === 0) throw new Error("Invalid Binance risk price or quantity.");
  return value;
}
function time(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Binance risk timestamp.");
  return value;
}
function identifier(value: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error("Invalid Binance history ID.");
  return value;
}
function assetPair(symbol: string): { base: string; quote: string } {
  const match = /^([A-Z0-9]+)-(USDT|USDC)$/.exec(symbol);
  if (!match || STABLE_ASSETS[match[1]] === true)
    throw new Error("Unsupported Binance risk symbol.");
  return { base: match[1], quote: match[2] };
}
function tolerance(left: number, right: number): number {
  return 64 * Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

// Evaluation-scoped: construct a new provider for every decision. Cached promises pin the
// same facts for repeated checks inside that decision; failures are never replaced by zeros.
export class BinanceRiskDataProvider implements RiskDataProvider {
  private readonly symbols: Set<string>;
  private readonly baseSymbols = new Map<string, string>();
  private readonly markets = new Map<string, Promise<MarketDataSnapshot>>();
  private snapshot?: Promise<BinanceAccountSnapshot>;
  private history?: Promise<BinanceRiskHistory>;
  private daily?: Promise<DailyStats>;
  private readonly date = new Date().toISOString().slice(0, 10);
  private readonly dayStart = Date.parse(`${this.date}T00:00:00.000Z`);

  constructor(private readonly source: BinanceRiskSource) {
    if (!source.account || !["spot", "usdm_futures"].includes(source.accountMode)) {
      throw new Error("Invalid Binance risk account binding.");
    }
    this.symbols = new Set(source.historySymbols);
    if (this.symbols.size === 0 || this.symbols.size !== source.historySymbols.length) {
      throw new Error("Binance risk requires a unique complete history universe.");
    }
    for (const symbol of this.symbols) {
      const { base } = assetPair(symbol);
      if (source.accountMode === "spot" && this.baseSymbols.has(base)) {
        throw new Error("Multiple quote assets for one spot base have ambiguous cost basis.");
      }
      this.baseSymbols.set(base, symbol);
    }
  }

  private assertAccount(account: string): void {
    if (account !== this.source.account)
      throw new Error("Binance risk account does not match the credential.");
    if (new Date().toISOString().slice(0, 10) !== this.date) {
      throw new Error("Binance risk collection crossed a UTC day boundary.");
    }
  }
  private assertSymbol(symbol: string): void {
    if (!this.symbols.has(symbol))
      throw new Error("Binance risk symbol is outside the history universe.");
  }

  async getMarketData(symbol: string): Promise<MarketDataSnapshot> {
    this.assertAccount(this.source.account);
    this.assertSymbol(symbol);
    let market = this.markets.get(symbol);
    if (!market) {
      market = this.source.getPrice(symbol).then((value) => {
        if (value.symbol !== symbol) throw new Error("Binance market symbol mismatch.");
        return { symbol, price: positive(value.price), timestampMs: time(value.timestampMs) };
      });
      this.markets.set(symbol, market);
    }
    return market;
  }

  private getSnapshot(account: string): Promise<BinanceAccountSnapshot> {
    this.assertAccount(account);
    if (!this.snapshot) {
      this.snapshot = this.source.getAccountSnapshot(account).then((snapshot) => {
        if (
          snapshot.account !== account ||
          !Array.isArray(snapshot.balances) ||
          !Array.isArray(snapshot.positions)
        ) {
          throw new Error("Invalid Binance account snapshot.");
        }
        time(snapshot.timestampMs);
        const assets = new Set<string>();
        for (const balance of snapshot.balances) {
          if (
            typeof balance.asset !== "string" ||
            !/^[A-Z0-9]+$/.test(balance.asset) ||
            assets.has(balance.asset)
          ) {
            throw new Error("Invalid or duplicate Binance balance asset.");
          }
          assets.add(balance.asset);
          const minimum = this.source.accountMode === "spot" ? 0 : Number.NEGATIVE_INFINITY;
          finite(balance.free, minimum);
          finite(balance.locked, minimum);
          finite(balance.free + balance.locked);
          if (balance.free !== 0 || balance.locked !== 0) {
            if (
              STABLE_ASSETS[balance.asset] !== true &&
              (this.source.accountMode !== "spot" || !this.baseSymbols.has(balance.asset))
            ) {
              throw new Error("Binance snapshot contains uncovered assets.");
            }
          }
        }
        const positions = new Set<string>();
        for (const position of snapshot.positions) {
          this.assertSymbol(position.symbol);
          if (positions.has(position.symbol)) throw new Error("Duplicate Binance position.");
          positions.add(position.symbol);
          finite(
            position.quantity,
            this.source.accountMode === "spot" ? 0 : Number.NEGATIVE_INFINITY,
          );
          finite(position.notionalUsd);
          positive(position.leverage);
          if (
            position.quantity === 0
              ? position.notionalUsd !== 0
              : position.quantity * position.notionalUsd <= 0
          ) {
            throw new Error("Binance position notional has an invalid direction.");
          }
        }
        if (this.source.accountMode === "spot") {
          for (const [base, symbol] of this.baseSymbols) {
            const balance = snapshot.balances.find((value) => value.asset === base);
            const held = balance ? balance.free + balance.locked : 0;
            const quantity =
              snapshot.positions.find((value) => value.symbol === symbol)?.quantity ?? 0;
            if (Math.abs(held - quantity) > tolerance(held, quantity)) {
              throw new Error("Spot positions do not cover the account balances.");
            }
          }
        }
        return snapshot;
      });
    }
    return this.snapshot;
  }

  async getPortfolio(account: string): Promise<PortfolioSnapshot> {
    const snapshot = await this.getSnapshot(account);
    return {
      account,
      timestampMs: snapshot.timestampMs,
      positions: snapshot.positions.map(({ symbol, quantity, notionalUsd }) => ({
        symbol,
        quantity,
        notionalUsd,
      })),
    };
  }

  private async getHistory(account: string): Promise<BinanceRiskHistory> {
    this.assertAccount(account);
    if (!this.history) this.history = this.source.getRiskHistory(account, this.date);
    const history = await this.history;
    this.assertAccount(account);
    const now = Date.now();
    if (
      history.account !== account ||
      history.date !== this.date ||
      !Array.isArray(history.trades) ||
      !Array.isArray(history.orders) ||
      !Array.isArray(history.income)
    ) {
      throw new Error("Invalid Binance risk history binding.");
    }
    time(history.timestampMs);
    if (
      history.timestampMs < this.dayStart ||
      history.timestampMs > now ||
      now - history.timestampMs > MAX_COLLECTION_AGE_MS
    ) {
      throw new Error("Binance risk history is stale or future-dated.");
    }
    if (history.lastOrderTimestampMs !== null && time(history.lastOrderTimestampMs) > now) {
      throw new Error("Binance last-order timestamp is future-dated.");
    }
    return history;
  }

  async getLastOrderTimestampMs(account: string): Promise<number | null> {
    return (await this.getHistory(account)).lastOrderTimestampMs;
  }

  async getDailyStats(account: string, date: string): Promise<DailyStats> {
    this.assertAccount(account);
    if (date !== this.date) throw new Error("Binance risk provider requires the current UTC date.");
    if (!this.daily) this.daily = this.calculateDailyStats(account);
    const result = await this.daily;
    await this.getHistory(account);
    return result;
  }

  private validateTrades(history: BinanceRiskHistory): BinanceTrade[] {
    const seen = new Set<string>();
    for (const trade of history.trades) {
      this.assertSymbol(trade.symbol);
      const key = `${trade.symbol}:${identifier(trade.id)}`;
      identifier(trade.orderId);
      if (seen.has(key)) throw new Error("Duplicate Binance trade record.");
      seen.add(key);
      if (trade.side !== "BUY" && trade.side !== "SELL")
        throw new Error("Invalid Binance trade side.");
      positive(trade.quantity);
      positive(trade.quoteQuantity);
      positive(trade.price);
      finite(trade.commission, 0);
      if (
        typeof trade.commissionAsset !== "string" ||
        (trade.commission > 0 && !trade.commissionAsset)
      ) {
        throw new Error("Invalid Binance commission asset.");
      }
      if (
        time(trade.timestampMs) > history.timestampMs ||
        (this.source.accountMode === "usdm_futures" && trade.timestampMs < this.dayStart)
      ) {
        throw new Error("Binance trade is outside the requested history window.");
      }
    }
    return history.trades;
  }

  private orderCount(history: BinanceRiskHistory): number {
    const orders = new Map<string, number>();
    for (const order of history.orders) {
      this.assertSymbol(order.symbol);
      const key = `${order.symbol}:${identifier(order.orderId)}`;
      if (time(order.timestampMs) < this.dayStart || order.timestampMs > history.timestampMs) {
        throw new Error("Binance order is outside the requested UTC day.");
      }
      const previous = orders.get(key);
      if (previous !== undefined && previous !== order.timestampMs)
        throw new Error("Inconsistent duplicate Binance order.");
      orders.set(key, order.timestampMs);
      if (
        history.lastOrderTimestampMs === null ||
        history.lastOrderTimestampMs < order.timestampMs
      ) {
        throw new Error("Binance last-order time does not cover today's orders.");
      }
    }
    return orders.size;
  }

  private async calculateDailyStats(account: string): Promise<DailyStats> {
    const history = await this.getHistory(account);
    const trades = this.validateTrades(history);
    let totalNotionalUsd = 0;
    for (const trade of trades) {
      if (trade.timestampMs >= this.dayStart) totalNotionalUsd += trade.quoteQuantity;
    }
    const realizedLossUsd =
      this.source.accountMode === "spot"
        ? this.spotLoss(trades, await this.getSnapshot(account), history)
        : this.futuresLoss(history);
    return {
      account,
      date: this.date,
      totalNotionalUsd: finite(totalNotionalUsd, 0),
      realizedLossUsd: finite(realizedLossUsd, 0),
      orderCount: this.orderCount(history),
    };
  }

  private spotLoss(
    trades: BinanceTrade[],
    snapshot: BinanceAccountSnapshot,
    history: BinanceRiskHistory,
  ): number {
    if (history.income.length !== 0)
      throw new Error("Spot history unexpectedly contains futures income.");
    if (Math.abs(snapshot.timestampMs - history.timestampMs) > MAX_COLLECTION_AGE_MS) {
      throw new Error("Spot inventory and history observations are too far apart.");
    }
    const lots = new Map<string, { quantity: number; cost: number }>();
    const sorted = [...trades].sort(
      (a, b) =>
        a.timestampMs - b.timestampMs ||
        (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0),
    );
    let loss = 0;
    for (const trade of sorted) {
      const { base } = assetPair(trade.symbol);
      const lot = lots.get(base) ?? { quantity: 0, cost: 0 };
      lots.set(base, lot);
      const baseFee = trade.commissionAsset === base ? trade.commission : 0;
      const quoteFee = STABLE_ASSETS[trade.commissionAsset] === true ? trade.commission : 0;
      if (trade.commission > 0 && baseFee === 0 && quoteFee === 0) {
        throw new Error("Unsupported commission asset for spot cost basis.");
      }
      if (trade.side === "BUY") {
        lot.quantity += positive(trade.quantity - baseFee);
        lot.cost += trade.quoteQuantity + quoteFee;
      } else {
        const spent = trade.quantity + baseFee;
        if (lot.quantity <= 0 || spent - lot.quantity > tolerance(spent, lot.quantity)) {
          throw new Error("Spot sell inventory has no complete cost basis.");
        }
        const cost = lot.cost * (spent / lot.quantity);
        const proceeds = trade.quoteQuantity - quoteFee;
        if (trade.timestampMs >= this.dayStart) loss += Math.max(0, cost - proceeds);
        lot.quantity -= spent;
        lot.cost -= cost;
        if (lot.quantity <= 0) {
          lot.quantity = 0;
          lot.cost = 0;
        }
      }
      finite(lot.quantity, 0);
      finite(lot.cost, 0);
    }
    for (const base of this.baseSymbols.keys()) {
      const reconstructed = lots.get(base)?.quantity ?? 0;
      const balance = snapshot.balances.find((value) => value.asset === base);
      const held = balance ? balance.free + balance.locked : 0;
      if (Math.abs(reconstructed - held) > tolerance(reconstructed, held)) {
        throw new Error("Spot inventory does not reconcile with complete trade cost basis.");
      }
    }
    return loss;
  }

  private futuresLoss(history: BinanceRiskHistory): number {
    const seen = new Set<string>();
    let loss = 0;
    for (const entry of history.income) {
      if (!entry.incomeType || typeof entry.incomeType !== "string")
        throw new Error("Invalid Binance income type.");
      const key = `${entry.incomeType}:${identifier(entry.id)}`;
      if (seen.has(key)) throw new Error("Duplicate Binance income record.");
      seen.add(key);
      finite(entry.income);
      if (time(entry.timestampMs) < this.dayStart || entry.timestampMs > history.timestampMs) {
        throw new Error("Binance income is outside the requested UTC day.");
      }
      if (TRANSFER_TYPES[entry.incomeType] === true) continue;
      if (STABLE_ASSETS[entry.asset] !== true)
        throw new Error("Binance income has an unknown USD value.");
      // Gross losses: profits do not restore the loss budget. Income already includes fees;
      // do not add trade commissions/realizedPnl a second time.
      loss += Math.max(0, -entry.income);
    }
    return loss;
  }
}
