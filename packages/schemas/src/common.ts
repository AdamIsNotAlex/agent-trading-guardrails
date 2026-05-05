import { z } from "zod";

export const Environment = z.enum(["dev", "paper", "testnet", "canary_live", "production"]);
export type Environment = z.infer<typeof Environment>;

export const RiskTier = z.enum(["low", "medium", "high", "critical"]);
export type RiskTier = z.infer<typeof RiskTier>;

export const PolicyDecision = z.enum(["allow", "deny", "needs_human"]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const ReviewerVerdict = z.enum(["approve", "reject", "needs_human"]);
export type ReviewerVerdict = z.infer<typeof ReviewerVerdict>;

export const HumanApprovalClass = z.enum(["none", "required", "break_glass"]);
export type HumanApprovalClass = z.infer<typeof HumanApprovalClass>;

export const CexAction = z.enum(["cex.place_order", "cex.cancel_order", "cex.get_order_status"]);
export type CexAction = z.infer<typeof CexAction>;

export const OnchainAction = z.enum(["onchain.simulate_transaction", "onchain.request_signature"]);
export type OnchainAction = z.infer<typeof OnchainAction>;

export const Action = z.enum([...CexAction.options, ...OnchainAction.options]);
export type Action = z.infer<typeof Action>;

export const OrderSide = z.enum(["buy", "sell"]);
export type OrderSide = z.infer<typeof OrderSide>;

export const OrderType = z.enum(["limit"]);
export type OrderType = z.infer<typeof OrderType>;

export const AccountMode = z.enum(["spot", "usdm_futures"]);
export type AccountMode = z.infer<typeof AccountMode>;

export const MarginType = z.enum(["isolated", "cross"]);
export type MarginType = z.infer<typeof MarginType>;

export const Chain = z.enum(["ethereum", "solana"]);
export type Chain = z.infer<typeof Chain>;

export const ChainEnvironment = z.enum(["sepolia", "devnet", "mainnet"]);
export type ChainEnvironment = z.infer<typeof ChainEnvironment>;
