import type { GuardedToolResult } from "./guarded-tools.js";
import { GuardrailEvaluateClient } from "./http-client.js";
import { OpenClawAdapter } from "./openclaw-adapter.js";
import { PLUGIN_ID, readPluginConfiguration, TOOL_PREFIX } from "./plugin-config.js";

// Structural subset of the native OpenClaw registerTool API. The distributable is bundled
// and has no SDK/runtime dependency on a second copy of the host or on GuardrailService.
export interface OpenClawTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: GuardedToolResult;
    isError: boolean;
  }>;
}

export interface OpenClawPluginApi {
  pluginConfig?: unknown;
  registerTool(tool: OpenClawTool, options: { optional: boolean }): void;
}

export default {
  id: PLUGIN_ID,
  name: "Trading Guardrails",
  description: "Remote trading authorization only; no exchange credentials or execution tools.",
  register(api: OpenClawPluginApi): void {
    const config = readPluginConfiguration(api.pluginConfig);
    const adapter = new OpenClawAdapter(
      new GuardrailEvaluateClient({ baseUrl: config.guardrailUrl, timeoutMs: config.timeoutMs }),
      config.principal,
      config.environment,
    );
    for (const definition of adapter.getToolDefinitions()) {
      api.registerTool(
        {
          name: `${TOOL_PREFIX}${definition.name}`,
          label: `Guardrails: ${definition.name}`,
          description: definition.description,
          parameters: definition.parameters,
          async execute(_toolCallId, params, signal) {
            const result = await adapter.executeTool(definition.name, params, { signal });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              details: result,
              isError: result.outcome === "deny",
            };
          },
        },
        { optional: true },
      );
    }
  },
};
