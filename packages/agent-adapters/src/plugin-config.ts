import { Environment } from "@guardrails/schemas";
import { DEFAULT_EVALUATE_TIMEOUT_MS } from "./http-client.js";

export const PLUGIN_ID = "trading-guardrails";
export const TOOL_PREFIX = "guardrails_";

export const pluginConfigSchema = {
  type: "object",
  additionalProperties: false,
  required: ["guardrailUrl", "principal", "environment"],
  properties: {
    guardrailUrl: {
      type: "string",
      minLength: 1,
      description: "Trusted Guardrail HTTP(S) base URL, not a Broker URL.",
    },
    principal: {
      type: "string",
      minLength: 1,
      description: "Operator-bound agent principal; never supplied by tool arguments.",
    },
    environment: { type: "string", enum: Environment.options },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      maximum: 60_000,
      default: DEFAULT_EVALUATE_TIMEOUT_MS,
    },
  },
};

export interface PluginConfiguration {
  guardrailUrl: string;
  principal: string;
  environment: Environment;
  timeoutMs: number;
}

export function readPluginConfiguration(value: unknown): PluginConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Trading guardrails requires trusted plugin configuration.");
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!Object.hasOwn(pluginConfigSchema.properties, key)) {
      throw new Error("Unknown trading guardrails configuration field.");
    }
  }
  if (typeof config.guardrailUrl !== "string" || !config.guardrailUrl.trim()) {
    throw new Error("guardrailUrl is required.");
  }
  if (typeof config.principal !== "string" || !config.principal.trim()) {
    throw new Error("principal is required.");
  }
  const environment = Environment.parse(config.environment);
  const timeoutMs = config.timeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new Error("timeoutMs must be an integer from 1 to 60000.");
  }
  return {
    guardrailUrl: config.guardrailUrl.trim(),
    principal: config.principal.trim(),
    environment,
    timeoutMs,
  };
}
