import { once } from "node:events";
import { redactSecrets } from "@guardrails/secrets";
import type { Runtime } from "./runtime.js";

export async function startRuntime(role: "guardrail" | "broker", create: () => Runtime) {
  let runtime: Runtime | undefined;
  try {
    process.umask(0o077);
    const prefix = role === "guardrail" ? "GUARDRAIL" : "BROKER";
    const port = Number(process.env[`${prefix}_PORT`] ?? (role === "guardrail" ? 3000 : 3001));
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`${prefix}_PORT must be an integer from 0 to 65535.`);
    }
    const host = process.env[`${prefix}_HOST`] ?? "127.0.0.1";
    if (!host.trim()) throw new Error(`${prefix}_HOST must not be empty.`);
    runtime = create();
    const { server, close } = runtime;
    server.requestTimeout = 60_000;
    server.headersTimeout = 10_000;
    server.listen(port, host);
    await once(server, "listening");
    console.log(JSON.stringify({ event: "listening", role, address: server.address() }));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close(() => {
        close();
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    runtime?.close();
    console.error(
      redactSecrets(error instanceof Error ? error.message : "Runtime startup failed."),
    );
    process.exitCode = 1;
  }
}
