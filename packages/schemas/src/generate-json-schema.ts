import { mkdirSync, writeFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AuditEvent,
  BrokerExecutionResult,
  CexCancelIntent,
  CexGetOpenOrdersIntent,
  CexGetPortfolioIntent,
  CexOrderIntent,
  CexOrderStatusIntent,
  DynamicRiskResult,
  OnchainQueryIntent,
  OnchainSigningIntent,
  OnchainSimulationIntent,
  PolicyInput,
  PolicyOutput,
  ReviewerVerdictSchema,
} from "./index.js";

const schemas = {
  "cex-order-intent": CexOrderIntent,
  "cex-cancel-intent": CexCancelIntent,
  "cex-order-status-intent": CexOrderStatusIntent,
  "cex-get-open-orders-intent": CexGetOpenOrdersIntent,
  "cex-get-portfolio-intent": CexGetPortfolioIntent,
  "onchain-simulation-intent": OnchainSimulationIntent,
  "onchain-signing-intent": OnchainSigningIntent,
  "onchain-query-intent": OnchainQueryIntent,
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
  const path = `${outDir}/${name}.json`;
  writeFileSync(path, `${JSON.stringify(jsonSchema, null, 2)}\n`);
  console.log(`Generated ${path}`);
}
