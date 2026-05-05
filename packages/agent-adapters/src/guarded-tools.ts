import type { GuardrailDecision, GuardrailService } from "@guardrails/service";

export interface GuardedToolResult {
  success: boolean;
  intentId: string;
  correlationId: string;
  outcome: string;
  approvalId?: string;
  reasons: Array<{ rule: string; message: string }>;
}

type GuardedEnvelopeFields = {
  intentId?: string;
  requestedAt?: string;
};

export class GuardedToolSurface {
  constructor(private guardrail: GuardrailService) {}

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
    return this.toResult(await this.guardrail.evaluate(intent));
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
    return this.toResult(await this.guardrail.evaluate(intent));
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
    return this.toResult(await this.guardrail.evaluate(intent));
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
    return this.toResult(await this.guardrail.evaluate(intent));
  }

  async queryOnchainPortfolio(
    params: {
      principal: string;
      chain: string;
      chainEnvironment: string;
      address: string;
      rationale: string;
      evidence: string[];
      environment: string;
      idempotencyKey: string;
    } & GuardedEnvelopeFields,
  ): Promise<GuardedToolResult> {
    const intent = {
      ...params,
      intentId: params.intentId ?? crypto.randomUUID(),
      action: "onchain.get_portfolio" as const,
      resource: `onchain:${params.chain}:${params.chainEnvironment}:${params.address}`,
      requestedAt: params.requestedAt ?? new Date().toISOString(),
    };
    return this.toResult(await this.guardrail.evaluate(intent));
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
    return this.toResult(await this.guardrail.evaluate(intent));
  }

  async queryOpenOrders(
    params: {
      principal: string;
      exchange: string;
      account: string;
      rationale: string;
      evidence: string[];
      environment: string;
      idempotencyKey: string;
    } & GuardedEnvelopeFields,
  ): Promise<GuardedToolResult> {
    const intent = {
      ...params,
      intentId: params.intentId ?? crypto.randomUUID(),
      action: "cex.get_open_orders" as const,
      resource: `cex:${params.exchange}:${params.account}`,
      requestedAt: params.requestedAt ?? new Date().toISOString(),
    };
    return this.toResult(await this.guardrail.evaluate(intent));
  }

  async queryPortfolio(
    params: {
      principal: string;
      exchange: string;
      account: string;
      rationale: string;
      evidence: string[];
      environment: string;
      idempotencyKey: string;
    } & GuardedEnvelopeFields,
  ): Promise<GuardedToolResult> {
    const intent = {
      ...params,
      intentId: params.intentId ?? crypto.randomUUID(),
      action: "cex.get_portfolio" as const,
      resource: `cex:${params.exchange}:${params.account}`,
      requestedAt: params.requestedAt ?? new Date().toISOString(),
    };
    return this.toResult(await this.guardrail.evaluate(intent));
  }

  private toResult(decision: GuardrailDecision): GuardedToolResult {
    return {
      success: decision.outcome === "allow",
      intentId: decision.intentId,
      correlationId: decision.correlationId,
      outcome: decision.outcome,
      approvalId: decision.approvalId,
      reasons: decision.reasons,
    };
  }
}
