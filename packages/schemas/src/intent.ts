import { z } from "zod";
import {
  AccountMode,
  Action,
  Chain,
  ChainEnvironment,
  Environment,
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
  quantity: z.number().positive().optional(),
  price: z.number().positive().optional(),
  maxNotionalUsd: z.number().positive(),
  maxSlippageBps: z.number().nonnegative().int(),
  leverage: z.number().int().min(1).optional(),
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

export const OnchainSimulationIntent = IntentEnvelope.extend({
  action: z.literal("onchain.simulate_transaction"),
  chain: Chain,
  chainEnvironment: ChainEnvironment,
  to: z.string().min(1),
  data: z.string().optional(),
  value: z.string().optional(),
  programId: z.string().optional(),
  instructions: z.array(z.record(z.unknown())).optional(),
}).strict();
export type OnchainSimulationIntent = z.infer<typeof OnchainSimulationIntent>;

export const OnchainSigningIntent = IntentEnvelope.extend({
  action: z.literal("onchain.request_signature"),
  chain: Chain,
  chainEnvironment: ChainEnvironment,
  to: z.string().min(1),
  data: z.string().optional(),
  value: z.string().optional(),
  programId: z.string().optional(),
  instructions: z.array(z.record(z.unknown())).optional(),
  simulationId: z.string().uuid(),
  maxTokenApprovalAmount: z.string().optional(),
}).strict();
export type OnchainSigningIntent = z.infer<typeof OnchainSigningIntent>;

export const TradingIntent = z.discriminatedUnion("action", [
  CexOrderIntent,
  CexCancelIntent,
  CexGetOpenOrdersIntent,
  CexGetPortfolioIntent,
  OnchainSimulationIntent,
  OnchainSigningIntent,
  OnchainQueryIntent,
]);
export type TradingIntent = z.infer<typeof TradingIntent>;
