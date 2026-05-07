import { mkdirSync, writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AuditEvent,
  BrokerExecutionResult,
  CexCancelIntent,
  CexOrderIntent,
  CexOrderStatusIntent,
  DynamicRiskResult,
  OnchainSigningIntent,
  OnchainSimulationIntent,
  PolicyInput,
  PolicyOutput,
  ReviewerVerdictSchema,
} from "./index.js";

const UINT256_MAX_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

function uint256DecimalPattern(): string {
  const sameLengthAlternatives = [...UINT256_MAX_DECIMAL]
    .map((digit, index) => {
      const value = Number(digit);
      if (index === 0 || value === 0) return null;
      const lowerDigit = value === 1 ? "0" : `[0-${value - 1}]`;
      const remainingDigits = UINT256_MAX_DECIMAL.length - index - 1;
      const tail = remainingDigits === 0 ? "" : `[0-9]{${remainingDigits}}`;
      return `${UINT256_MAX_DECIMAL.slice(0, index)}${lowerDigit}${tail}`;
    })
    .filter((value): value is string => value !== null);
  return `^(0|[1-9][0-9]{0,76}|${sameLengthAlternatives.join("|")}|${UINT256_MAX_DECIMAL})$`;
}

function patchMaxTokenApprovalAmount(schema: unknown): void {
  if (!schema || typeof schema !== "object") return;
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (properties && typeof properties === "object") {
    const maxTokenApprovalAmount = (properties as Record<string, unknown>).maxTokenApprovalAmount;
    if (maxTokenApprovalAmount && typeof maxTokenApprovalAmount === "object") {
      (maxTokenApprovalAmount as Record<string, unknown>).pattern = uint256DecimalPattern();
    }
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) patchMaxTokenApprovalAmount(item);
      continue;
    }
    patchMaxTokenApprovalAmount(value);
  }
}

const schemas = {
  "cex-order-intent": CexOrderIntent,
  "cex-cancel-intent": CexCancelIntent,
  "cex-order-status-intent": CexOrderStatusIntent,
  "onchain-simulation-intent": OnchainSimulationIntent,
  "onchain-signing-intent": OnchainSigningIntent,
  "reviewer-verdict": ReviewerVerdictSchema,
  "policy-input": PolicyInput,
  "policy-output": PolicyOutput,
  "dynamic-risk-result": DynamicRiskResult,
  "broker-execution-result": BrokerExecutionResult,
  "audit-event": AuditEvent,
} as const;

const outDir = new URL("../json-schema", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

for (const [name, schema] of Object.entries(schemas)) {
  const jsonSchema = zodToJsonSchema(schema, name);
  if (name === "onchain-signing-intent") patchMaxTokenApprovalAmount(jsonSchema);
  const path = `${outDir}/${name}.json`;
  writeFileSync(path, `${JSON.stringify(jsonSchema, null, 2)}\n`);
  console.log(`Generated ${path}`);
}
