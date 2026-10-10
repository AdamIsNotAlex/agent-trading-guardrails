import { runCanaryDryRun } from "./canary-dry-run.js";

try {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("Dry-run intent exceeds 1 MiB.");
    chunks.push(buffer);
  }
  const report = await runCanaryDryRun(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")), {
    guardrailUrl: process.env.GUARDRAIL_URL,
    brokerUrl: process.env.BROKER_URL,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "blocked") process.exitCode = 1;
} catch {
  // Endpoint errors and inputs can contain credentials; report only a fixed operator message.
  console.error(
    "Canary dry-run failed. Supply one JSON intent and trusted Guardrail/Broker origins.",
  );
  process.exitCode = 1;
}
