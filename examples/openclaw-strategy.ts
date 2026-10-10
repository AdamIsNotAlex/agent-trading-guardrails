import { GuardrailEvaluateClient, OpenClawAdapter } from "@guardrails/agent-adapters";

export type OpenClawStrategySignal = {
  id: string;
  intentId: string;
  observedAt: string;
};

export async function runOpenClawStrategy(guardrailUrl: string, signal: OpenClawStrategySignal) {
  const adapter = new OpenClawAdapter(
    new GuardrailEvaluateClient({ baseUrl: guardrailUrl }),
    "agent.openclaw.strategy-alpha",
    "canary_live",
  );

  const result = await adapter.executeTool("propose_order", {
    exchange: "binance",
    account: "subaccount-1",
    accountMode: "spot",
    symbol: "ETH-USDC",
    side: "buy",
    orderType: "limit",
    quantity: 0.002,
    price: 3500,
    maxNotionalUsd: 8,
    maxSlippageBps: 30,
    rationale: "Buy a small ETH-USDC canary position within configured guardrail limits.",
    evidence: ["market-snapshot:eth-usdc:2026-05-04T12:00:00.000Z"],
    idempotencyKey: `${signal.id}:openclaw:eth-usdc-buy`,
    intentId: signal.intentId,
    requestedAt: signal.observedAt,
  });

  if (result.outcome === "needs_human") {
    return {
      status: "awaiting_human_approval" as const,
      approvalId: result.approvalId,
      reasons: result.reasons,
    };
  }

  if (!result.success) {
    return {
      status: "rejected" as const,
      reasons: result.reasons,
    };
  }

  return {
    status: "accepted" as const,
    intentId: result.intentId,
    correlationId: result.correlationId,
  };
}
