import type { Environment as EnvironmentType } from "@guardrails/schemas";
import { Environment } from "@guardrails/schemas";
import { assertNotVaultDevInProduction } from "@guardrails/secrets";

export interface GuardrailConfig {
  environment: EnvironmentType;
  opaUrl: string;
  approvalTimeoutSeconds: number;
  decisionSigningSecret: string;
  vaultAddr?: string;
}

export function loadDevConfig(): GuardrailConfig {
  const environment = Environment.parse(process.env.GUARDRAIL_ENV?.trim().toLowerCase() ?? "dev");
  const vaultAddr = process.env.VAULT_ADDR;

  if (vaultAddr) {
    assertNotVaultDevInProduction(environment, vaultAddr);
  }

  const approvalTimeoutSeconds = parseApprovalTimeoutSeconds(process.env.APPROVAL_TIMEOUT_SECONDS);

  return {
    environment,
    opaUrl: process.env.OPA_URL ?? "http://localhost:8181",
    approvalTimeoutSeconds,
    decisionSigningSecret: process.env.GUARDRAIL_DECISION_SECRET ?? "dev-decision-secret",
    vaultAddr,
  };
}

function parseApprovalTimeoutSeconds(value: string | undefined): number {
  if (value === undefined) return 300;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("APPROVAL_TIMEOUT_SECONDS must be a positive integer.");
  }
  return parsed;
}
