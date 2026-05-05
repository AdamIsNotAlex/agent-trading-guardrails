import type { GuardrailService } from "@guardrails/service";
import {
  executeGuardedTool,
  type GuardedToolResult,
  GuardedToolSurface,
  getGuardedToolDefinitions,
} from "./guarded-tools.js";

export class OpenClawAdapter {
  private tools: GuardedToolSurface;
  readonly agentType = "openclaw" as const;

  constructor(
    guardrail: GuardrailService,
    private principal: string,
    private environment: string,
  ) {
    this.tools = new GuardedToolSurface(guardrail);
  }

  getToolDefinitions(): ReturnType<typeof getGuardedToolDefinitions> {
    return getGuardedToolDefinitions();
  }

  async executeTool(toolName: string, params: Record<string, unknown>): Promise<GuardedToolResult> {
    return executeGuardedTool(
      this.tools,
      { principal: this.principal, environment: this.environment },
      toolName,
      params,
    );
  }
}
