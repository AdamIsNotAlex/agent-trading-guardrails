import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { TradingIntent } from "@guardrails/schemas";
import {
  DEFAULT_EVALUATE_TIMEOUT_MS,
  DEFAULT_GUARDRAIL_URL,
  GuardrailEvaluateClient,
} from "./http-client.js";

export interface AgentCliOptions {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type AgentLineErrorCode =
  | "invalid_json"
  | "invalid_intent"
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_response";

export interface AgentLineError {
  error: AgentLineErrorCode;
  message: string;
  correlationId?: string;
}

export function isCliEntrypoint(
  argv1: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (!argv1) return false;
  try {
    return pathToFileURL(resolve(argv1)).href === moduleUrl;
  } catch {
    return false;
  }
}

export async function runAgentCli(options: AgentCliOptions): Promise<number> {
  const env = options.env ?? process.env;
  let client: GuardrailEvaluateClient;
  try {
    client = new GuardrailEvaluateClient({
      baseUrl: env.GUARDRAIL_URL?.trim() || DEFAULT_GUARDRAIL_URL,
      timeoutMs: options.timeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "GUARDRAIL_URL must be a valid http or https base URL.";
    options.stderr.write(`agent-adapters: ${message}\n`);
    return 1;
  }

  options.stderr.write(`agent-adapters: submitting intents to ${client.evaluateUrl().href}\n`);

  let failed = false;
  const rl = createInterface({
    input: options.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  const abortReadline = () => {
    rl.close();
  };
  options.signal?.addEventListener("abort", abortReadline, { once: true });

  try {
    for await (const rawLine of rl) {
      if (options.signal?.aborted) {
        failed = true;
        break;
      }

      const line = rawLine.trim();
      if (line.length === 0) continue;

      const parsedJson = parseJsonLine(line);
      if (!parsedJson.ok) {
        failed = true;
        options.stdout.write(`${JSON.stringify(parsedJson.error)}\n`);
        continue;
      }

      const parsedIntent = TradingIntent.safeParse(parsedJson.value);
      if (!parsedIntent.success) {
        failed = true;
        options.stdout.write(
          `${JSON.stringify({
            error: "invalid_intent",
            message: "Input line is not a valid TradingIntent.",
          })}\n`,
        );
        continue;
      }

      const result = await client.evaluate(parsedIntent.data, { signal: options.signal });
      if (result.ok) {
        options.stdout.write(`${JSON.stringify(result.decision)}\n`);
        continue;
      }

      failed = true;
      if (result.error === "interrupted") {
        break;
      }

      options.stdout.write(
        `${JSON.stringify({
          error: result.error,
          message: result.message,
          correlationId: result.correlationId,
        })}\n`,
      );
    }
  } finally {
    options.signal?.removeEventListener("abort", abortReadline);
    rl.close();
  }

  if (options.signal?.aborted) return 1;
  return failed ? 1 : 0;
}

function parseJsonLine(
  line: string,
): { ok: true; value: unknown } | { ok: false; error: AgentLineError } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return {
      ok: false,
      error: {
        error: "invalid_json",
        message: "Input line is not valid JSON.",
      },
    };
  }
}

async function runCliAndExit(): Promise<void> {
  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let code = 1;
  try {
    code = await runAgentCli({
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      signal: controller.signal,
    });
    if (controller.signal.aborted) code = 1;
  } catch {
    code = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  process.stdin.pause();
  process.exitCode = code;
}

if (isCliEntrypoint()) {
  void runCliAndExit();
}
