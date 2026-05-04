import type { Environment as EnvironmentType } from "@guardrails/schemas";
import { Environment } from "@guardrails/schemas";
import { assertNotVaultDevInProduction } from "@guardrails/secrets";

export interface GuardrailConfig {
  environment: EnvironmentType;
  opaUrl: string;
  approvalTimeoutSeconds: number;
  vaultAddr?: string;
}

export function loadDevConfig(): GuardrailConfig {
  const environment = Environment.parse(process.env.GUARDRAIL_ENV?.trim().toLowerCase() ?? "dev");
  const vaultAddr = process.env.VAULT_ADDR;

  if (vaultAddr) {
    assertNotVaultDevInProduction(environment, vaultAddr);
  }

  return {
    environment,
    opaUrl: process.env.OPA_URL ?? "http://localhost:8181",
    approvalTimeoutSeconds: Number(process.env.APPROVAL_TIMEOUT_SECONDS) || 300,
    vaultAddr,
  };
}
