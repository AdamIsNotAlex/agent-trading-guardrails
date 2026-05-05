import { HermesAgentAdapter } from "@guardrails/agent-adapters";
import type { GuardrailService } from "@guardrails/service";

export type HermesStrategySignal = {
  id: string;
  simulationIntentId: string;
  signingIntentId: string;
  observedAt: string;
};

export async function runHermesStrategy(guardrail: GuardrailService, signal: HermesStrategySignal) {
  const adapter = new HermesAgentAdapter(guardrail, "agent.hermes.strategy-beta", "testnet");
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

  const simulation = await adapter.executeTool("simulate_transaction", {
    chain: "solana",
    chainEnvironment: "devnet",
    to: tokenProgram,
    programId: tokenProgram,
    instructions: [
      {
        programId: tokenProgram,
        type: "transfer",
      },
    ],
    expectedDeltas: [
      {
        account: "So11111111111111111111111111111111111111112",
        asset: "SOL",
        minDelta: "-1000000",
        maxDelta: "0",
      },
    ],
    rationale: "Simulate a Solana devnet token transfer before requesting a guarded signature.",
    evidence: ["simulation-input:solana-devnet-transfer-001"],
    idempotencyKey: `${signal.id}:hermes:solana-simulation`,
    intentId: signal.simulationIntentId,
    requestedAt: signal.observedAt,
  });

  if (simulation.outcome === "needs_human") {
    return {
      status: "simulation_awaiting_human_approval" as const,
      approvalId: simulation.approvalId,
      reasons: simulation.reasons,
    };
  }

  if (!simulation.success) {
    return {
      status: "simulation_rejected" as const,
      reasons: simulation.reasons,
    };
  }

  const signing = await adapter.executeTool("request_signature", {
    chain: "solana",
    chainEnvironment: "devnet",
    to: tokenProgram,
    programId: tokenProgram,
    instructions: [
      {
        programId: tokenProgram,
        type: "transfer",
      },
    ],
    simulationId: simulation.intentId,
    expectedDeltas: [
      {
        account: "So11111111111111111111111111111111111111112",
        asset: "SOL",
        minDelta: "-1000000",
        maxDelta: "0",
      },
    ],
    rationale: "Request a signature only after the guarded simulation step succeeds.",
    evidence: [simulation.intentId],
    idempotencyKey: `${signal.id}:hermes:solana-signing`,
    intentId: signal.signingIntentId,
    requestedAt: signal.observedAt,
  });

  if (signing.outcome === "needs_human") {
    return {
      status: "awaiting_human_approval" as const,
      approvalId: signing.approvalId,
      reasons: signing.reasons,
    };
  }

  if (!signing.success) {
    return {
      status: "signature_rejected" as const,
      reasons: signing.reasons,
    };
  }

  return {
    status: "signature_accepted" as const,
    intentId: signing.intentId,
    correlationId: signing.correlationId,
  };
}
