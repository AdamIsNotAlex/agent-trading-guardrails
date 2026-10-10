import { executeGuardedTool, type GuardedToolResult, GuardedToolSurface } from "./guarded-tools.js";
import type { GuardrailEvaluateClient, GuardrailRequestOptions } from "./http-client.js";
import { getGuardedToolDefinitions } from "./tool-definitions.js";

export class HermesAgentAdapter {
  readonly agentType = "hermes" as const;

  constructor(
    private readonly client: GuardrailEvaluateClient,
    private principal: string,
    private environment: string,
  ) {}

  getToolDefinitions(): ReturnType<typeof getGuardedToolDefinitions> {
    return getGuardedToolDefinitions();
  }

  async executeTool(
    toolName: string,
    params: Record<string, unknown>,
    options: GuardrailRequestOptions = {},
  ): Promise<GuardedToolResult> {
    return executeGuardedTool(
      new GuardedToolSurface(this.client, options),
      { principal: this.principal, environment: this.environment },
      toolName,
      params,
    );
  }
}
