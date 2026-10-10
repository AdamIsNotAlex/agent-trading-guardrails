import { TradingIntent } from "@guardrails/schemas";
import type { GuardrailDecision } from "@guardrails/service";
import type { GuardrailEvaluateClient, GuardrailRequestOptions } from "./http-client.js";
import { isGuardedToolName } from "./tool-definitions.js";

export interface GuardedToolResult {
  success: boolean;
  intentId: string;
  correlationId: string;
  outcome: string;
  approvalId?: string;
  decidedAt?: string;
  decisionToken?: string;
  intent?: TradingIntent;
  reasons: Array<{ rule: string; message: string }>;
}

export interface GuardedAgentContext {
  principal: string;
  environment: string;
}

type GuardedEnvelopeFields = {
  intentId?: string;
  requestedAt?: string;
};

export async function executeGuardedTool(
  tools: GuardedToolSurface,
  context: GuardedAgentContext,
  toolName: string,
  params: Record<string, unknown>,
): Promise<GuardedToolResult> {
  if (!isGuardedToolName(toolName)) {
    return rejectToolCall("unknown_tool", `Tool ${toolName} is not available.`);
  }

  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return rejectToolCall("schema_validation", "Tool arguments must be an object.");
  }

  if (params.idempotencyKey == null || String(params.idempotencyKey).length === 0) {
    return rejectToolCall("idempotency_required", "idempotencyKey is required.");
  }

  const base = {
    principal: context.principal,
    environment: context.environment,
    rationale: String(params.rationale ?? ""),
    evidence: Array.isArray(params.evidence) ? params.evidence.map(String) : [],
    idempotencyKey: String(params.idempotencyKey),
    intentId: params.intentId != null ? String(params.intentId) : undefined,
    requestedAt: params.requestedAt != null ? String(params.requestedAt) : undefined,
  };

  switch (toolName) {
    case "propose_order":
      return tools.proposeOrder({
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
        marginType: params.marginType != null ? String(params.marginType) : undefined,
      });
    case "cancel_order":
      return tools.proposeCancelOrder({
        ...base,
        exchange: String(params.exchange ?? "binance"),
        account: String(params.account ?? ""),
        orderId: String(params.orderId ?? ""),
        symbol: String(params.symbol ?? ""),
      });
    case "simulate_transaction":
      return tools.proposeSimulation({
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
      return tools.requestSignature({
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
    case "get_order_status":
      return tools.queryOrderStatus({
        ...base,
        exchange: String(params.exchange ?? "binance"),
        account: String(params.account ?? ""),
        orderId: String(params.orderId ?? ""),
        symbol: String(params.symbol ?? ""),
      });
    default:
      return rejectToolCall("unknown_tool", `Tool ${toolName} is not available.`);
  }
}

function rejectToolCall(rule: string, message: string): GuardedToolResult {
  return {
    success: false,
    intentId: "",
    correlationId: "",
    outcome: "deny",
    reasons: [{ rule, message }],
  };
}

export class GuardedToolSurface {
  constructor(
    private readonly guardrail: GuardrailEvaluateClient,
    private readonly options: GuardrailRequestOptions = {},
  ) {}

  async proposeOrder(
    params: {
      principal: string;
      exchange: string;
      account: string;
      accountMode: string;
      symbol: string;
      side: string;
      orderType: string;
      quantity?: number;
      price?: number;
      maxNotionalUsd: number;
      maxSlippageBps: number;
      leverage?: number;
      marginType?: string;
      rationale: string;
      evidence: string[];
      environment: string;
      idempotencyKey: string;
    } & GuardedEnvelopeFields,
  ): Promise<GuardedToolResult> {
    const intent = {
      ...params,
      intentId: params.intentId ?? crypto.randomUUID(),
      action: "cex.place_order" as const,
      resource: `cex:${params.exchange}:${params.account}:${params.symbol}`,
      requestedAt: params.requestedAt ?? new Date().toISOString(),
    };
    return this.evaluateIntent(intent);
  }

  async proposeCancelOrder(
    params: {
      principal: string;
      exchange: string;
      account: string;
      orderId: string;
      symbol: string;
      rationale: string;
      evidence: string[];
      environment: string;
      idempotencyKey: string;
    } & GuardedEnvelopeFields,
  ): Promise<GuardedToolResult> {
    const intent = {
      ...params,
      intentId: params.intentId ?? crypto.randomUUID(),
      action: "cex.cancel_order" as const,
      resource: `cex:${params.exchange}:${params.account}:${params.symbol}`,
      requestedAt: params.requestedAt ?? new Date().toISOString(),
    };
    return this.evaluateIntent(intent);
  }

  async proposeSimulation(
    params: {
      principal: string;
      chain: string;
      chainEnvironment: string;
      to: string;
      data?: unknown;
      value?: unknown;
      programId?: unknown;
      instructions?: unknown;
      expectedDeltas?: unknown;
      rationale: string;
      evidence: string[];
      environment: string;
      idempotencyKey: string;
    } & GuardedEnvelopeFields,
  ): Promise<GuardedToolResult> {
    const intent = {
      ...params,
      intentId: params.intentId ?? crypto.randomUUID(),
      action: "onchain.simulate_transaction" as const,
      resource: `onchain:${params.chain}:${params.chainEnvironment}:${params.to}`,
      requestedAt: params.requestedAt ?? new Date().toISOString(),
    };
    return this.evaluateIntent(intent);
  }

  async requestSignature(
    params: {
      principal: string;
      chain: string;
      chainEnvironment: string;
      to: string;
      data?: unknown;
      value?: unknown;
      programId?: unknown;
      instructions?: unknown;
      expectedDeltas?: unknown;
      simulationId: string;
      maxTokenApprovalAmount?: unknown;
      rationale: string;
      evidence: string[];
      environment: string;
      idempotencyKey: string;
    } & GuardedEnvelopeFields,
  ): Promise<GuardedToolResult> {
    const intent = {
      ...params,
      intentId: params.intentId ?? crypto.randomUUID(),
      action: "onchain.request_signature" as const,
      resource: `onchain:${params.chain}:${params.chainEnvironment}:${params.to}`,
      requestedAt: params.requestedAt ?? new Date().toISOString(),
    };
    return this.evaluateIntent(intent);
  }

  async queryOrderStatus(
    params: {
      principal: string;
      exchange: string;
      account: string;
      orderId: string;
      symbol: string;
      rationale: string;
      evidence: string[];
      environment: string;
      idempotencyKey: string;
    } & GuardedEnvelopeFields,
  ): Promise<GuardedToolResult> {
    const intent = {
      ...params,
      intentId: params.intentId ?? crypto.randomUUID(),
      action: "cex.get_order_status" as const,
      resource: `cex:${params.exchange}:${params.account}:${params.symbol}`,
      requestedAt: params.requestedAt ?? new Date().toISOString(),
    };
    return this.evaluateIntent(intent);
  }

  private async evaluateIntent(input: unknown): Promise<GuardedToolResult> {
    const parsed = TradingIntent.safeParse(input);
    if (!parsed.success) {
      return rejectToolCall(
        "schema_validation",
        "Tool arguments do not form a valid TradingIntent.",
      );
    }
    const result = await this.guardrail.evaluate(parsed.data, this.options);
    if (!result.ok) {
      return {
        ...rejectToolCall(result.error, result.message),
        intentId: parsed.data.intentId,
        correlationId: result.correlationId,
      };
    }
    return this.toResult(result.decision, parsed.data);
  }

  private toResult(decision: GuardrailDecision, intent: TradingIntent): GuardedToolResult {
    const approved = decision.outcome === "allow" || decision.outcome === "needs_human";
    return {
      success: decision.outcome === "allow",
      intentId: decision.intentId,
      correlationId: decision.correlationId,
      outcome: decision.outcome,
      approvalId: decision.approvalId,
      decidedAt: approved ? decision.decidedAt : undefined,
      decisionToken: approved ? decision.decisionToken : undefined,
      intent: approved ? intent : undefined,
      reasons: decision.reasons,
    };
  }
}
