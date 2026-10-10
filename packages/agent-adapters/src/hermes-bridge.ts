import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { HermesAgentAdapter } from "./hermes-adapter.js";
import { GuardrailEvaluateClient } from "./http-client.js";
import { readPluginConfiguration } from "./plugin-config.js";

export async function runHermesBridge(options: {
  stdin: Readable;
  stdout: Writable;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<number> {
  try {
    const config = readPluginConfiguration({
      guardrailUrl: options.env.GUARDRAIL_URL,
      principal: options.env.GUARDRAIL_PRINCIPAL,
      environment: options.env.GUARDRAIL_ENV,
      timeoutMs:
        options.env.GUARDRAIL_TIMEOUT_MS === undefined
          ? undefined
          : Number(options.env.GUARDRAIL_TIMEOUT_MS),
    });
    const adapter = new HermesAgentAdapter(
      new GuardrailEvaluateClient({ baseUrl: config.guardrailUrl, timeoutMs: config.timeoutMs }),
      config.principal,
      config.environment,
    );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of options.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 1_048_576) throw new Error("Invocation too large.");
      chunks.push(bytes);
    }
    const invocation: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) {
      throw new Error("Invalid invocation.");
    }
    if (
      !("toolName" in invocation) ||
      typeof invocation.toolName !== "string" ||
      !("params" in invocation) ||
      !invocation.params ||
      typeof invocation.params !== "object" ||
      Array.isArray(invocation.params)
    ) {
      throw new Error("Invalid invocation.");
    }
    const result = await adapter.executeTool(
      invocation.toolName,
      invocation.params as Record<string, unknown>,
      { signal: options.signal },
    );
    options.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    options.stdout.write(
      `${JSON.stringify({
        success: false,
        outcome: "deny",
        intentId: "",
        correlationId: "",
        error: "Guardrail bridge configuration or invocation failed.",
        reasons: [
          { rule: "bridge_error", message: "Guardrail bridge configuration or invocation failed." },
        ],
      })}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  runHermesBridge({
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    signal: controller.signal,
  })
    .then((code) => {
      process.exitCode = code;
    })
    .finally(() => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    });
}
