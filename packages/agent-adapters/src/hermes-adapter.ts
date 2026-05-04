import type { GuardrailService } from "@guardrails/service";
import { type GuardedToolResult, GuardedToolSurface } from "./guarded-tools.js";

export class HermesAgentAdapter {
  private tools: GuardedToolSurface;
  readonly agentType = "hermes" as const;

  constructor(
    guardrail: GuardrailService,
    private principal: string,
    private environment: string,
  ) {
    this.tools = new GuardedToolSurface(guardrail);
  }

  getToolDefinitions() {
    return [
      { name: "propose_order", description: "Propose a CEX order through guardrails" },
      { name: "cancel_order", description: "Cancel a CEX order through guardrails" },
      { name: "simulate_transaction", description: "Simulate an onchain transaction" },
      { name: "get_open_orders", description: "Query open orders (read-only)" },
      { name: "get_portfolio", description: "Query portfolio (read-only)" },
    ];
  }

  async executeTool(toolName: string, params: Record<string, unknown>): Promise<GuardedToolResult> {
    const base = {
      principal: this.principal,
      environment: this.environment,
      rationale: String(params.rationale ?? ""),
      evidence: Array.isArray(params.evidence) ? params.evidence.map(String) : [],
      idempotencyKey: String(params.idempotencyKey ?? crypto.randomUUID()),
    };

    switch (toolName) {
      case "propose_order":
        return this.tools.proposeOrder({
          ...base,
          exchange: String(params.exchange ?? "binance"),
          account: String(params.account ?? ""),
          accountMode: String(params.accountMode ?? "spot"),
          symbol: String(params.symbol ?? ""),
          side: String(params.side ?? ""),
          orderType: String(params.orderType ?? "limit"),
          quantity: params.quantity != null ? Number(params.quantity) : undefined,
          price: params.price != null ? Number(params.price) : undefined,
          maxNotionalUsd: Number(params.maxNotionalUsd ?? 0),
          maxSlippageBps: Number(params.maxSlippageBps ?? 0),
          leverage: params.leverage != null ? Number(params.leverage) : undefined,
        });
      case "cancel_order":
        return this.tools.proposeCancelOrder({
          ...base,
          exchange: String(params.exchange ?? "binance"),
          account: String(params.account ?? ""),
          orderId: String(params.orderId ?? ""),
          symbol: String(params.symbol ?? ""),
        });
      case "simulate_transaction":
        return this.tools.proposeSimulation({
          ...base,
          chain: String(params.chain ?? ""),
          chainEnvironment: String(params.chainEnvironment ?? ""),
          to: String(params.to ?? ""),
          data: params.data != null ? String(params.data) : undefined,
          value: params.value != null ? String(params.value) : undefined,
        });
      case "get_open_orders":
        return this.tools.queryOpenOrders({
          ...base,
          exchange: String(params.exchange ?? "binance"),
          account: String(params.account ?? ""),
        });
      case "get_portfolio":
        return this.tools.queryPortfolio({
          ...base,
          exchange: String(params.exchange ?? "binance"),
          account: String(params.account ?? ""),
        });
      default:
        return {
          success: false,
          intentId: "",
          correlationId: "",
          outcome: "deny",
          reasons: [{ rule: "unknown_tool", message: `Tool ${toolName} is not available.` }],
        };
    }
  }
}
