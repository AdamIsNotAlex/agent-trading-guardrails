import { z } from "zod";
import {
  AccountMode,
  Action,
  Chain,
  ChainEnvironment,
  Environment,
  MarginType,
  OrderSide,
  OrderType,
} from "./common.js";

export const IntentEnvelope = z
  .object({
    intentId: z.string().uuid(),
    principal: z.string().min(1),
    action: Action,
    resource: z.string().min(1),
    environment: Environment,
    requestedAt: z.string().datetime(),
    idempotencyKey: z.string().min(1),
    rationale: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type IntentEnvelope = z.infer<typeof IntentEnvelope>;

export const CexOrderIntent = IntentEnvelope.extend({
  action: z.literal("cex.place_order"),
  exchange: z.literal("binance"),
  account: z.string().min(1),
  accountMode: AccountMode,
  symbol: z.string().min(1),
  side: OrderSide,
  orderType: OrderType,
  quantity: z.number().finite().positive(),
  price: z.number().finite().positive(),
  maxNotionalUsd: z.number().finite().positive(),
  maxSlippageBps: z.number().finite().nonnegative().int(),
  leverage: z.number().finite().int().min(1).optional(),
  marginType: MarginType.optional(),
}).strict();
export type CexOrderIntent = z.infer<typeof CexOrderIntent>;

export const CexCancelIntent = IntentEnvelope.extend({
  action: z.literal("cex.cancel_order"),
  exchange: z.literal("binance"),
  account: z.string().min(1),
  orderId: z.string().min(1),
  symbol: z.string().min(1),
}).strict();
export type CexCancelIntent = z.infer<typeof CexCancelIntent>;

export const CexOrderStatusIntent = IntentEnvelope.extend({
  action: z.literal("cex.get_order_status"),
  exchange: z.literal("binance"),
  account: z.string().min(1),
  orderId: z.string().min(1),
  symbol: z.string().min(1),
}).strict();
export type CexOrderStatusIntent = z.infer<typeof CexOrderStatusIntent>;

export const CexGetOpenOrdersIntent = IntentEnvelope.extend({
  action: z.literal("cex.get_open_orders"),
  exchange: z.literal("binance"),
  account: z.string().min(1),
}).strict();
export type CexGetOpenOrdersIntent = z.infer<typeof CexGetOpenOrdersIntent>;

export const CexGetPortfolioIntent = IntentEnvelope.extend({
  action: z.literal("cex.get_portfolio"),
  exchange: z.literal("binance"),
  account: z.string().min(1),
}).strict();
export type CexGetPortfolioIntent = z.infer<typeof CexGetPortfolioIntent>;

export const OnchainQueryIntent = IntentEnvelope.extend({
  action: z.literal("onchain.get_portfolio"),
  chain: Chain,
  chainEnvironment: ChainEnvironment,
  address: z.string().min(1),
}).strict();
export type OnchainQueryIntent = z.infer<typeof OnchainQueryIntent>;

const IntegerDelta = z.string().regex(/^-?\d+$/);

export const EvmExpectedBalanceDelta = z
  .object({
    address: z.string().min(1),
    asset: z.string().min(1),
    minDelta: IntegerDelta,
    maxDelta: IntegerDelta,
  })
  .strict();
export type EvmExpectedBalanceDelta = z.infer<typeof EvmExpectedBalanceDelta>;

export const SolanaExpectedBalanceDelta = z
  .object({
    account: z.string().min(1),
    asset: z.string().min(1),
    minDelta: IntegerDelta,
    maxDelta: IntegerDelta,
  })
  .strict();
export type SolanaExpectedBalanceDelta = z.infer<typeof SolanaExpectedBalanceDelta>;

const OnchainSimulationBase = {
  action: z.literal("onchain.simulate_transaction"),
  chainEnvironment: ChainEnvironment,
  to: z.string().min(1),
  data: z.string().optional(),
  value: z.string().optional(),
  programId: z.string().optional(),
  instructions: z.array(z.record(z.unknown())).optional(),
};

const EvmOnchainSimulationIntent = IntentEnvelope.extend({
  ...OnchainSimulationBase,
  chain: z.literal("ethereum"),
  expectedDeltas: z.array(EvmExpectedBalanceDelta).optional(),
}).strict();

const SolanaOnchainSimulationIntent = IntentEnvelope.extend({
  ...OnchainSimulationBase,
  chain: z.literal("solana"),
  expectedDeltas: z.array(SolanaExpectedBalanceDelta).optional(),
}).strict();

export const OnchainSimulationIntent = z.union([
  EvmOnchainSimulationIntent,
  SolanaOnchainSimulationIntent,
]);
export type OnchainSimulationIntent = z.infer<typeof OnchainSimulationIntent>;

const OnchainSigningBase = {
  action: z.literal("onchain.request_signature"),
  chainEnvironment: ChainEnvironment,
  to: z.string().min(1),
  data: z.string().optional(),
  value: z.string().optional(),
  programId: z.string().optional(),
  instructions: z.array(z.record(z.unknown())).optional(),
  simulationId: z.string().uuid(),
  maxTokenApprovalAmount: z.string().optional(),
};

const EvmOnchainSigningIntent = IntentEnvelope.extend({
  ...OnchainSigningBase,
  chain: z.literal("ethereum"),
  expectedDeltas: z.array(EvmExpectedBalanceDelta).nonempty(),
}).strict();

const SolanaOnchainSigningIntent = IntentEnvelope.extend({
  ...OnchainSigningBase,
  chain: z.literal("solana"),
  programId: z.string().min(1),
  expectedDeltas: z.array(SolanaExpectedBalanceDelta).nonempty(),
}).strict();

export const OnchainSigningIntent = z.union([EvmOnchainSigningIntent, SolanaOnchainSigningIntent]);
export type OnchainSigningIntent = z.infer<typeof OnchainSigningIntent>;

export const TradingIntent = z.union([
  CexOrderIntent,
  CexCancelIntent,
  CexOrderStatusIntent,
  CexGetOpenOrdersIntent,
  CexGetPortfolioIntent,
  OnchainSimulationIntent,
  OnchainSigningIntent,
  OnchainQueryIntent,
]);
export type TradingIntent = z.infer<typeof TradingIntent>;
