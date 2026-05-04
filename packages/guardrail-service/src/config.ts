import type { Environment } from "@guardrails/schemas";

export interface GuardrailConfig {
  environment: Environment;
  opaUrl: string;
  approvalTimeoutSeconds: number;
}

export function loadDevConfig(): GuardrailConfig {
  return {
    environment: (process.env.GUARDRAIL_ENV as Environment) ?? "dev",
    opaUrl: process.env.OPA_URL ?? "http://localhost:8181",
    approvalTimeoutSeconds: Number(process.env.APPROVAL_TIMEOUT_SECONDS) || 300,
  };
}
