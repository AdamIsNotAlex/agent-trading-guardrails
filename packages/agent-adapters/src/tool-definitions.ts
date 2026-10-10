import {
  CexCancelIntent,
  CexOrderIntent,
  CexOrderStatusIntent,
  OnchainSigningIntent,
  OnchainSimulationIntent,
} from "@guardrails/schemas";
import { zodToJsonSchema } from "zod-to-json-schema";

const trustedFields = { principal: true, environment: true, action: true, resource: true } as const;

export type GuardedToolName =
  | "propose_order"
  | "cancel_order"
  | "simulate_transaction"
  | "request_signature"
  | "get_order_status";

export interface GuardedToolDefinition {
  name: GuardedToolName;
  description: string;
  parameters: Record<string, unknown>;
}

function parameters(schema: Parameters<typeof zodToJsonSchema>[0]): Record<string, unknown> {
  const { $schema: _, ...json } = zodToJsonSchema(schema, { $refStrategy: "none" });
  return json;
}

function onchainParameters(schemas: Array<Parameters<typeof zodToJsonSchema>[0]>) {
  const branches = schemas.map(parameters);
  const properties: Record<string, unknown> = {};
  for (const branch of branches) {
    for (const [name, value] of Object.entries(branch.properties as Record<string, unknown>)) {
      properties[name] = Object.hasOwn(properties, name)
        ? { anyOf: [properties[name], value] }
        : value;
    }
  }
  // Both hosts require an object at the root. Keep branch constraints, including Solana's
  // required programId and chain-specific deltas, instead of flattening away those rules.
  return {
    type: "object",
    properties,
    additionalProperties: false,
    required: (branches[0].required as string[]).filter((name) =>
      branches.every((branch) => (branch.required as string[]).includes(name)),
    ),
    anyOf: branches,
  };
}

const definitions: GuardedToolDefinition[] = [
  {
    name: "propose_order",
    description:
      "Request Guardrail authorization for a CEX order. Does not submit an exchange order.",
    parameters: parameters(CexOrderIntent.omit(trustedFields)),
  },
  {
    name: "cancel_order",
    description:
      "Request Guardrail authorization to cancel a CEX order. Does not execute cancellation.",
    parameters: parameters(CexCancelIntent.omit(trustedFields)),
  },
  {
    name: "simulate_transaction",
    description:
      "Submit an onchain simulation intent for Guardrail evaluation. Does not run an RPC simulation.",
    parameters: onchainParameters([
      OnchainSimulationIntent.options[0].omit(trustedFields),
      OnchainSimulationIntent.options[1].omit(trustedFields),
    ]),
  },
  {
    name: "request_signature",
    description:
      "Request Guardrail authorization for signing after simulation. Does not sign or broadcast.",
    parameters: onchainParameters([
      OnchainSigningIntent.options[0].omit(trustedFields),
      OnchainSigningIntent.options[1].omit(trustedFields),
    ]),
  },
  {
    name: "get_order_status",
    description:
      "Request Guardrail authorization for an order-status query. Does not query the exchange.",
    parameters: parameters(CexOrderStatusIntent.omit(trustedFields)),
  },
];

export function getGuardedToolDefinitions(): GuardedToolDefinition[] {
  return structuredClone(definitions);
}

export function isGuardedToolName(name: string): name is GuardedToolName {
  return definitions.some((definition) => definition.name === name);
}
