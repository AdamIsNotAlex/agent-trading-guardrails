import { OfflineSignature, SigningRequest, verifyOfflineSignature } from "./signer-request.js";

try {
  const endpoint = new URL(process.env.SIGNER_URL ?? "http://127.0.0.1:3002");
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  ) {
    throw new Error("SIGNER_URL must be a plain trusted HTTP(S) origin.");
  }
  endpoint.pathname = "/sign";
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("Signing request exceeds 1 MiB.");
    chunks.push(buffer);
  }
  const request = SigningRequest.parse(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Signer rejected the request (HTTP ${response.status}).`);
  const result = OfflineSignature.parse(await response.json());
  await verifyOfflineSignature(request, result);
  console.log(JSON.stringify(result));
} catch (error) {
  // Do not print input bodies, signed transactions, tokens, or fetch exception details.
  console.error(
    error instanceof Error && error.message.startsWith("Signer ")
      ? error.message
      : "Signing request failed.",
  );
  process.exitCode = 1;
}
