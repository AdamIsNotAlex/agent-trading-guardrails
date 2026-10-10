import { createHmac } from "node:crypto";
import type {
  BinanceAccountSnapshot,
  BinanceApiClient,
  BinanceApiKeyPermissions,
  BinanceOrderResult,
  CancelOrderParams,
  FuturesMarginTypeParams,
  FuturesOrderParams,
  OrderStatusParams,
  SpotOrderParams,
} from "./interfaces.js";
import type {
  BinanceAccountMode,
  BinanceHistoricalOrder,
  BinanceIncome,
  BinanceRestConfig,
  BinanceRestOptions,
  BinanceRiskHistory,
  BinanceRiskSource,
  BinanceTrade,
} from "./rest-types.js";
import { validateIpAllowlist } from "./validation.js";

const DAY_MS = 86_400_000;
const MAINNET_SAPI_ORIGIN = "https://api.binance.com";
const PAGE_SIZE = 1000;
const ORDER_STATUSES: Record<string, true> = {
  NEW: true,
  PENDING_NEW: true,
  PARTIALLY_FILLED: true,
  FILLED: true,
  CANCELED: true,
  PENDING_CANCEL: true,
  REJECTED: true,
  EXPIRED: true,
  EXPIRED_IN_MATCH: true,
};
type Row = Record<string, unknown>;
type Params = Record<string, string | number>;

function invalid(): never {
  throw new Error("Binance returned invalid or incomplete data.");
}
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Row;
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) return invalid();
  return value.map(row);
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return invalid();
  return value;
}
function number(value: unknown, minimum = Number.NEGATIVE_INFINITY): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value))) {
    return invalid();
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum) return invalid();
  return result;
}
function positive(value: unknown): number {
  const result = number(value, 0);
  if (result === 0) return invalid();
  return result;
}
function timestamp(value: unknown): number {
  const result = number(value, 0);
  if (!Number.isSafeInteger(result)) return invalid();
  return result;
}
function id(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return value;
  return invalid();
}
function side(value: unknown): "BUY" | "SELL" {
  if (value !== "BUY" && value !== "SELL") return invalid();
  return value;
}
function flag(value: unknown): boolean {
  if (value !== true && value !== false) return invalid();
  return value;
}
function stable(asset: string): boolean {
  return asset === "USDT" || asset === "USDC";
}
function wireSymbol(symbol: string): string {
  if (!/^[A-Z0-9]+-(USDT|USDC)$/.test(symbol)) {
    throw new Error("Binance symbols must use BASE-USDT or BASE-USDC notation.");
  }
  return symbol.replace("-", "");
}
// Binance DECIMAL fields reject exponential notation; never round a caller's approved quantity.
function decimal(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw new Error("Binance order price and quantity must be positive finite numbers.");
  }
  const [mantissa, exponent] = String(value).split("e");
  if (exponent === undefined) return mantissa;
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

export class BinanceRestClient implements BinanceApiClient, BinanceRiskSource {
  readonly account: string;
  readonly accountMode: BinanceAccountMode;
  readonly historySymbols: readonly string[];
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly recvWindowMs: number;
  private readonly origin: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly allowedSymbols: readonly string[];
  private readonly testnet: boolean;
  private readonly maxLeverage: number;

  constructor(config: BinanceRestConfig, options: BinanceRestOptions = {}) {
    if (
      !config.account.trim() ||
      config.allowedAccounts.length !== 1 ||
      config.allowedAccounts[0] !== config.account ||
      !config.apiKey.trim() ||
      !config.apiSecret.trim() ||
      typeof config.testnet !== "boolean"
    ) {
      throw new Error("Binance requires credentials bound to exactly one configured account.");
    }
    if (config.accountMode !== "spot" && config.accountMode !== "usdm_futures") {
      throw new Error("Unsupported Binance account mode.");
    }
    this.account = config.account;
    this.accountMode = config.accountMode;
    const allowed =
      config.accountMode === "spot" ? config.allowedSpotSymbols : config.allowedFuturesSymbols;
    const other =
      config.accountMode === "spot" ? config.allowedFuturesSymbols : config.allowedSpotSymbols;
    if (other.length > 0 || allowed.length === 0 || config.historySymbols.length === 0) {
      throw new Error(
        "Binance client must be bound to a single product and nonempty symbol universe.",
      );
    }
    const seen = new Set<string>();
    const bases = new Set<string>();
    for (const symbol of config.historySymbols) {
      wireSymbol(symbol);
      const base = symbol.split("-")[0];
      if (seen.has(symbol) || stable(base) || (config.accountMode === "spot" && bases.has(base))) {
        throw new Error("Binance history symbols have duplicate or ambiguous asset coverage.");
      }
      seen.add(symbol);
      bases.add(base);
    }
    if (allowed.some((symbol) => !seen.has(symbol))) {
      throw new Error("Binance history symbols must cover enabled trading symbols.");
    }
    if (
      !Number.isInteger(config.maxFuturesLeverage) ||
      config.maxFuturesLeverage < 1 ||
      config.maxFuturesLeverage > 125
    ) {
      throw new Error("Binance futures leverage limit must be between 1 and 125.");
    }
    this.historySymbols = Object.freeze([...config.historySymbols]);
    this.allowedSymbols = Object.freeze([...allowed]);
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.testnet = config.testnet;
    if (!config.testnet) {
      const allowlist = validateIpAllowlist(config.ipAllowlist);
      if (!allowlist.valid) throw new Error(allowlist.reason);
    }
    this.maxLeverage = config.maxFuturesLeverage;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.recvWindowMs = options.recvWindowMs ?? 5000;
    for (const value of [this.timeoutMs, this.recvWindowMs]) {
      if (!Number.isInteger(value) || value < 1 || value > 60_000) {
        throw new Error("Binance timeouts and receive windows must be between 1 and 60000ms.");
      }
    }
    this.origin =
      config.accountMode === "spot"
        ? config.testnet
          ? "https://testnet.binance.vision"
          : "https://api.binance.com"
        : config.testnet
          ? "https://demo-fapi.binance.com"
          : "https://fapi.binance.com";
  }

  private assertAccount(account: string): void {
    if (account !== this.account)
      throw new Error("Binance account is not bound to this credential.");
  }
  private symbol(symbol: string, trading = false): string {
    if (!(trading ? this.allowedSymbols : this.historySymbols).includes(symbol)) {
      throw new Error("Binance symbol is not in the configured universe.");
    }
    return wireSymbol(symbol);
  }
  private assertMode(mode: BinanceAccountMode): void {
    if (this.accountMode !== mode)
      throw new Error("Binance operation does not match the configured product.");
  }
  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Params = {},
    signed = true,
    origin = this.origin,
  ): Promise<unknown> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    if (signed) {
      query.set("timestamp", String(timestamp(this.now())));
      query.set("recvWindow", String(this.recvWindowMs));
      query.set(
        "signature",
        createHmac("sha256", this.apiSecret).update(query.toString()).digest("hex"),
      );
    }
    let response: Response;
    let value: unknown;
    try {
      response = await this.fetcher(`${origin}${path}?${query}`, {
        method,
        headers: signed ? { "X-MBX-APIKEY": this.apiKey } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
      value = await response.json();
    } catch {
      // Never attach the fetch cause: it can contain a signed URL or a credential-bearing header.
      throw new Error(
        `Binance ${method} ${path} transport or response failure; execution may be unknown.`,
      );
    }
    const code =
      value && typeof value === "object" && "code" in value ? (value as Row).code : undefined;
    if (!response.ok || (typeof code === "number" && code < 0)) {
      const suffix = typeof code === "number" && Number.isSafeInteger(code) ? `, code ${code}` : "";
      throw new Error(
        `Binance ${method} ${path} failed (HTTP ${response.status}${suffix}); execution may be unknown.`,
      );
    }
    return value;
  }

  async getPrice(symbol: string) {
    const started = this.now();
    const path = this.accountMode === "spot" ? "/api/v3/ticker/price" : "/fapi/v2/ticker/price";
    const data = row(await this.request("GET", path, { symbol: this.symbol(symbol) }, false));
    if (data.symbol !== wireSymbol(symbol)) return invalid();
    return {
      symbol,
      price: positive(data.price),
      // Spot ticker has no event time: use request-start observation time, not completion time.
      timestampMs: this.accountMode === "spot" ? started : timestamp(data.time),
    };
  }

  private async futuresPositions(symbol?: string): Promise<Row[]> {
    const data = rows(
      await this.request(
        "GET",
        "/fapi/v2/positionRisk",
        symbol ? { symbol: this.symbol(symbol) } : {},
      ),
    );
    for (const position of data) {
      if (position.positionSide !== "BOTH")
        throw new Error("Binance hedge-mode positions are not supported.");
    }
    return data;
  }

  async getAccountSnapshot(account: string): Promise<BinanceAccountSnapshot> {
    this.assertAccount(account);
    let timestampMs = this.now();
    const positions: BinanceAccountSnapshot["positions"] = [];
    if (this.accountMode === "spot") {
      const data = row(await this.request("GET", "/api/v3/account", { omitZeroBalances: "true" }));
      const balances = rows(data.balances).map((balance) => ({
        asset: text(balance.asset),
        free: number(balance.free, 0),
        locked: number(balance.locked, 0),
      }));
      const seen = new Set<string>();
      for (const balance of balances) {
        if (seen.has(balance.asset)) return invalid();
        seen.add(balance.asset);
        const quantity = balance.free + balance.locked;
        if (!Number.isFinite(quantity)) return invalid();
        if (quantity === 0 || stable(balance.asset)) continue;
        const symbol = this.historySymbols.find((item) => item.split("-")[0] === balance.asset);
        if (!symbol) throw new Error("Binance account contains an uncovered asset.");
        const market = await this.getPrice(symbol);
        timestampMs = Math.min(timestampMs, market.timestampMs);
        positions.push({
          symbol,
          quantity,
          notionalUsd: number(quantity * market.price),
          leverage: 1,
        });
      }
      return { account, balances, positions, timestampMs };
    }
    const data = row(await this.request("GET", "/fapi/v3/account"));
    const balances = rows(data.assets).map((asset) => {
      const balance = number(asset.walletBalance);
      const available = number(asset.availableBalance);
      const name = text(asset.asset);
      if ((balance !== 0 || available !== 0) && !stable(name)) {
        throw new Error("Binance futures account contains unsupported collateral.");
      }
      return { asset: name, free: available, locked: balance - available };
    });
    for (const position of await this.futuresPositions()) {
      const quantity = number(position.positionAmt);
      if (quantity === 0) continue;
      const symbol = this.historySymbols.find((item) => wireSymbol(item) === position.symbol);
      if (!symbol) throw new Error("Binance account contains an uncovered futures position.");
      const leverage = positive(position.leverage);
      if (!Number.isInteger(leverage) || position.marginType !== "isolated") {
        throw new Error("Binance futures positions must use isolated margin.");
      }
      const notionalUsd = number(position.notional);
      if (quantity * notionalUsd <= 0) return invalid();
      positions.push({ symbol, quantity, notionalUsd, leverage });
    }
    return { account, balances, positions, timestampMs };
  }

  async getFuturesMarginType(params: FuturesMarginTypeParams): Promise<"isolated" | "cross"> {
    this.assertAccount(params.account);
    this.assertMode("usdm_futures");
    const data = await this.futuresPositions(params.symbol);
    if (data.length !== 1 || data[0].symbol !== wireSymbol(params.symbol)) return invalid();
    const marginType = data[0].marginType;
    if (marginType !== "isolated" && marginType !== "cross") return invalid();
    return marginType;
  }

  private orderParams(params: SpotOrderParams): Params {
    this.assertAccount(params.account);
    if (params.type !== "LIMIT" && params.type !== "MARKET")
      throw new Error("Unsupported Binance order type.");
    const result: Params = {
      symbol: this.symbol(params.symbol, true),
      side: side(params.side),
      type: params.type,
      quantity: decimal(params.quantity),
      newOrderRespType: "RESULT",
    };
    if (params.type === "LIMIT") {
      result.price = decimal(params.price);
      result.timeInForce = "GTC";
    } else if (params.price !== undefined) {
      throw new Error("Binance market orders must not specify a limit price.");
    }
    if (params.clientOrderId !== undefined) {
      if (!/^[.A-Z:/a-z0-9_-]{1,36}$/.test(params.clientOrderId))
        throw new Error("Invalid Binance client order ID.");
      result.newClientOrderId = params.clientOrderId;
    }
    return result;
  }
  private orderResult(value: unknown, symbol: string): BinanceOrderResult {
    const data = row(value);
    if (data.symbol !== wireSymbol(symbol)) return invalid();
    const status = text(data.status);
    if (!Object.hasOwn(ORDER_STATUSES, status)) return invalid();
    const executedQty = number(data.executedQty, 0);
    const quote = this.accountMode === "spot" ? number(data.cummulativeQuoteQty, 0) : undefined;
    const avgPrice =
      this.accountMode === "spot"
        ? executedQty > 0
          ? positive(quote) / executedQty
          : 0
        : number(data.avgPrice, 0);
    if (!Number.isFinite(avgPrice) || (executedQty > 0 && avgPrice <= 0)) return invalid();
    return {
      orderId: id(data.orderId),
      symbol,
      side: side(data.side),
      status,
      executedQty,
      avgPrice,
    };
  }

  async placeSpotOrder(params: SpotOrderParams): Promise<BinanceOrderResult> {
    this.assertMode("spot");
    const request = this.orderParams(params);
    const result = this.orderResult(
      await this.request("POST", "/api/v3/order", request),
      params.symbol,
    );
    if (result.side !== params.side) return invalid();
    return result;
  }
  async placeFuturesOrder(params: FuturesOrderParams): Promise<BinanceOrderResult> {
    this.assertMode("usdm_futures");
    const request = this.orderParams(params);
    if (
      !Number.isInteger(params.leverage) ||
      params.leverage < 1 ||
      params.leverage > this.maxLeverage
    ) {
      throw new Error("Binance requested leverage exceeds the configured limit.");
    }
    if ((await this.getFuturesMarginType(params)) !== "isolated") {
      throw new Error("Binance futures orders require isolated margin.");
    }
    const leverage = row(
      await this.request("POST", "/fapi/v1/leverage", {
        symbol: request.symbol,
        leverage: params.leverage,
      }),
    );
    if (leverage.symbol !== request.symbol || number(leverage.leverage) !== params.leverage)
      return invalid();
    request.positionSide = "BOTH";
    const result = this.orderResult(
      await this.request("POST", "/fapi/v1/order", request),
      params.symbol,
    );
    if (result.side !== params.side) return invalid();
    return result;
  }
  private async orderById(
    method: "GET" | "DELETE",
    params: OrderStatusParams,
  ): Promise<BinanceOrderResult> {
    this.assertAccount(params.account);
    const requestedId = id(params.orderId);
    const path = this.accountMode === "spot" ? "/api/v3/order" : "/fapi/v1/order";
    const result = this.orderResult(
      await this.request(method, path, {
        symbol: this.symbol(params.symbol),
        orderId: requestedId,
      }),
      params.symbol,
    );
    if (result.orderId !== requestedId) return invalid();
    return result;
  }
  cancelOrder(params: CancelOrderParams): Promise<BinanceOrderResult> {
    return this.orderById("DELETE", params);
  }
  getOrderStatus(params: OrderStatusParams): Promise<BinanceOrderResult> {
    return this.orderById("GET", params);
  }
  async getApiKeyPermissions(): Promise<BinanceApiKeyPermissions> {
    if (this.testnet) {
      throw new Error("Binance API key permissions are not queried on testnet.");
    }
    const data = row(
      await this.request("GET", "/sapi/v1/account/apiRestrictions", {}, true, MAINNET_SAPI_ORIGIN),
    );
    return {
      ipRestrict: flag(data.ipRestrict),
      enableWithdrawals: flag(data.enableWithdrawals),
      enableReading: flag(data.enableReading),
      enableSpotAndMarginTrading: flag(data.enableSpotAndMarginTrading),
      enableFutures: flag(data.enableFutures),
    };
  }

  private trade(data: Row, symbol: string): BinanceTrade {
    if (data.symbol !== wireSymbol(symbol)) return invalid();
    if (this.accountMode === "spot" && typeof data.isBuyer !== "boolean") return invalid();
    return {
      id: id(data.id),
      orderId: id(data.orderId),
      symbol,
      side: this.accountMode === "spot" ? (data.isBuyer ? "BUY" : "SELL") : side(data.side),
      quantity: positive(data.qty),
      quoteQuantity: positive(data.quoteQty),
      price: positive(data.price),
      commission: number(data.commission, 0),
      commissionAsset: text(data.commissionAsset),
      timestampMs: timestamp(data.time),
    };
  }
  // A full time-window page is ambiguous. Split inclusive windows; never increment past a
  // timestamp with unseen rows. An unsplittable saturated millisecond fails closed.
  private async timeWindow(
    path: string,
    params: Params,
    start: number,
    end: number,
  ): Promise<Row[]> {
    if (end < start) return [];
    const result = rows(
      await this.request("GET", path, {
        ...params,
        startTime: start,
        endTime: end,
        limit: PAGE_SIZE,
      }),
    );
    if (result.length > PAGE_SIZE) return invalid();
    for (const item of result) {
      const time = timestamp(item.time);
      if (time < start || time > end) return invalid();
    }
    if (result.length < PAGE_SIZE) return result;
    if (start === end)
      throw new Error(
        "Binance history exceeds one millisecond page; completeness cannot be established.",
      );
    const middle = start + Math.floor((end - start) / 2);
    return [
      ...(await this.timeWindow(path, params, start, middle)),
      ...(await this.timeWindow(path, params, middle + 1, end)),
    ];
  }
  private async spotTrades(symbol: string, cutoff: number): Promise<BinanceTrade[]> {
    const trades: BinanceTrade[] = [];
    let fromId = "0";
    for (;;) {
      const page = rows(
        await this.request("GET", "/api/v3/myTrades", {
          symbol: this.symbol(symbol),
          fromId,
          limit: PAGE_SIZE,
        }),
      );
      if (page.length > PAGE_SIZE) return invalid();
      let previous = BigInt(fromId) - 1n;
      let beyondCutoff = false;
      for (const item of page) {
        const trade = this.trade(item, symbol);
        const current = BigInt(trade.id);
        if (current <= previous) throw new Error("Binance trade history cursor did not advance.");
        previous = current;
        if (trade.timestampMs <= cutoff) trades.push(trade);
        else beyondCutoff = true;
      }
      if (page.length < PAGE_SIZE || beyondCutoff) return trades;
      fromId = String(previous + 1n);
    }
  }

  async getRiskHistory(account: string, date: string): Promise<BinanceRiskHistory> {
    this.assertAccount(account);
    const cutoff = timestamp(this.now());
    const start = Date.parse(`${date}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(start) ||
      new Date(start).toISOString().slice(0, 10) !== date ||
      start > cutoff
    ) {
      throw new Error("Binance risk history requires a valid non-future UTC date.");
    }
    // Futures APIs discard canceled orders after three days. Do not present an old day as complete.
    if (this.accountMode === "usdm_futures" && cutoff - start >= 3 * DAY_MS) {
      throw new Error("Binance futures daily order history is outside complete retention.");
    }
    const end = Math.min(cutoff, start + DAY_MS - 1);
    const trades: BinanceTrade[] = [];
    const orders: BinanceHistoricalOrder[] = [];
    const income: BinanceIncome[] = [];
    let lastOrderTimestampMs: number | null = null;
    const orderPath = this.accountMode === "spot" ? "/api/v3/allOrders" : "/fapi/v1/allOrders";
    for (const symbol of this.historySymbols) {
      if (this.accountMode === "spot") trades.push(...(await this.spotTrades(symbol, end)));
      else {
        const fills = await this.timeWindow(
          "/fapi/v1/userTrades",
          { symbol: this.symbol(symbol) },
          start,
          end,
        );
        trades.push(...fills.map((item) => this.trade(item, symbol)));
      }
      for (const item of await this.timeWindow(
        orderPath,
        { symbol: this.symbol(symbol) },
        start,
        end,
      )) {
        if (item.symbol !== wireSymbol(symbol)) return invalid();
        orders.push({ orderId: id(item.orderId), symbol, timestampMs: timestamp(item.time) });
      }
      const latest = rows(
        await this.request("GET", orderPath, { symbol: this.symbol(symbol), limit: 1 }),
      );
      if (latest.length > 1) return invalid();
      if (latest.length === 1) {
        if (latest[0].symbol !== wireSymbol(symbol)) return invalid();
        const time = timestamp(latest[0].time);
        lastOrderTimestampMs = Math.max(lastOrderTimestampMs ?? 0, time);
      }
    }
    if (this.accountMode === "usdm_futures") {
      const seen = new Set<string>();
      for (let page = 1; ; page++) {
        const entries = rows(
          await this.request("GET", "/fapi/v1/income", {
            startTime: start,
            endTime: end,
            page,
            limit: PAGE_SIZE,
          }),
        );
        if (entries.length > PAGE_SIZE) return invalid();
        for (const item of entries) {
          const incomeType = text(item.incomeType);
          const incomeId = id(item.tranId);
          const key = `${incomeType}:${incomeId}`;
          const time = timestamp(item.time);
          if (seen.has(key) || time < start || time > end) return invalid();
          seen.add(key);
          if (
            item.symbol !== "" &&
            item.symbol !== undefined &&
            !this.historySymbols.some((symbol) => wireSymbol(symbol) === item.symbol)
          ) {
            throw new Error("Binance income contains an uncovered symbol.");
          }
          income.push({
            id: incomeId,
            asset: text(item.asset),
            income: number(item.income),
            incomeType,
            timestampMs: time,
          });
        }
        if (entries.length < PAGE_SIZE) break;
      }
    }
    return { account, date, timestampMs: cutoff, trades, orders, income, lastOrderTimestampMs };
  }
}
