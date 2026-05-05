import type { GuardrailService } from "@guardrails/service";
import { type GuardedToolResult, GuardedToolSurface } from "./guarded-tools.js";

export class OpenClawAdapter {
  private tools: GuardedToolSurface;
  readonly agentType = "openclaw" as const;

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
      { name: "request_signature", description: "Request an onchain signature through guardrails" },
      { name: "get_onchain_portfolio", description: "Query onchain portfolio (read-only)" },
      { name: "get_order_status", description: "Query order status (read-only)" },
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
          data: params.data,
          value: params.value,
          programId: params.programId,
          instructions: params.instructions,
          expectedDeltas: params.expectedDeltas,
        });
      case "request_signature":
        return this.tools.requestSignature({
          ...base,
          chain: String(params.chain ?? ""),
          chainEnvironment: String(params.chainEnvironment ?? ""),
          to: String(params.to ?? ""),
          data: params.data,
          value: params.value,
          programId: params.programId,
          instructions: params.instructions,
          expectedDeltas: params.expectedDeltas,
          simulationId: String(params.simulationId ?? ""),
          maxTokenApprovalAmount: params.maxTokenApprovalAmount,
        });
      case "get_onchain_portfolio":
        return this.tools.queryOnchainPortfolio({
          ...base,
          chain: String(params.chain ?? ""),
          chainEnvironment: String(params.chainEnvironment ?? ""),
          address: String(params.address ?? ""),
        });
      case "get_order_status":
        return this.tools.queryOrderStatus({
          ...base,
          exchange: String(params.exchange ?? "binance"),
          account: String(params.account ?? ""),
          orderId: String(params.orderId ?? ""),
          symbol: String(params.symbol ?? ""),
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
