import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { binanceSpotOrder } from "@guardrails/schemas/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { CORRELATION_ID_HEADER, CORRELATION_ID_PATTERN } from "./http-client.js";
import { runAgentCli } from "./main.js";

type CapturedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
};

type TestServer = {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
};

const validIntent = {
  ...binanceSpotOrder,
  intentId: "550e8400-e29b-41d4-a716-4466554400aa",
};

function decisionFor(intentId: string, correlationId: string) {
  return {
    intentId,
    correlationId,
    outcome: "allow" as const,
    reasons: [{ rule: "allowlist_match", message: "Intent is allowed." }],
    requiresHumanApproval: false,
    reviewerVerdict: null,
    policyOutput: null,
    riskResult: null,
    decidedAt: "2026-05-04T12:00:00.000Z",
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? JSON.parse(text) : null;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void | Promise<void>,
): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (req, res) => {
    const body = await readJson(req);
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body,
    });
    await handler(req, res, body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not bind.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function runCli(input: string, env: NodeJS.ProcessEnv, timeoutMs?: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = "";
  let stderrText = "";
  stdout.on("data", (chunk: Buffer | string) => {
    stdoutText += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  });
  stderr.on("data", (chunk: Buffer | string) => {
    stderrText += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  });

  stdin.end(input);
  const exitCode = await runAgentCli({
    stdin,
    stdout,
    stderr,
    env,
    timeoutMs,
  });
  return { exitCode, stdout: stdoutText, stderr: stderrText };
}

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

describe("agent intent submission CLI", () => {
  it("rejects invalid GUARDRAIL_URL before reading intents", async () => {
    const result = await runCli(`${JSON.stringify(validIntent)}\n`, {
      GUARDRAIL_URL: "ftp://example.com",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("does not submit invalid intents and continues subsequent lines", async () => {
    const server = await listen((req, res, body) => {
      const header = req.headers[CORRELATION_ID_HEADER];
      const correlationId = typeof header === "string" ? header : "missing";
      const intentId =
        body && typeof body === "object" && "intentId" in body && typeof body.intentId === "string"
          ? body.intentId
          : "unknown";
      res.writeHead(200, {
        "content-type": "application/json",
        [CORRELATION_ID_HEADER]: correlationId,
      });
      res.end(JSON.stringify(decisionFor(intentId, correlationId)));
    });
    servers.push(server);

    const result = await runCli(
      [
        "{not-json",
        JSON.stringify({ action: "cex.place_order" }),
        "",
        JSON.stringify(validIntent),
      ].join("\n"),
      { GUARDRAIL_URL: server.url },
    );

    expect(result.exitCode).toBe(1);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/evaluate",
      body: validIntent,
    });
    expect(server.requests[0].headers["content-type"]).toMatch(/application\/json/i);
    expect(server.requests[0].headers[CORRELATION_ID_HEADER]).toMatch(CORRELATION_ID_PATTERN);

    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ error: "invalid_json" });
    expect(lines[1]).toMatchObject({ error: "invalid_intent" });
    expect(lines[2]).toMatchObject({
      intentId: validIntent.intentId,
      outcome: "allow",
      requiresHumanApproval: false,
    });
    expect(lines[2].error).toBeUndefined();
  });

  it("does not report HTTP errors as guardrail decisions", async () => {
    const server = await listen((req, res) => {
      const header = req.headers[CORRELATION_ID_HEADER];
      const correlationId = typeof header === "string" ? header : "corr-http-error";
      res.writeHead(500, {
        "content-type": "application/json",
        [CORRELATION_ID_HEADER]: correlationId,
      });
      res.end(
        JSON.stringify({
          secret: "super-secret-key",
          stack: "Error: vault token is abcdef",
          outcome: "allow",
        }),
      );
    });
    servers.push(server);

    const result = await runCli(`${JSON.stringify(validIntent)}\n`, { GUARDRAIL_URL: server.url });

    expect(result.exitCode).toBe(1);
    expect(server.requests).toHaveLength(1);
    const [line] = result.stdout
      .trim()
      .split("\n")
      .map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(line.error).toBe("http_error");
    expect(line.outcome).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain("super-secret-key");
    expect(JSON.stringify(line)).not.toContain("vault token");
    expect(line.correlationId).toMatch(CORRELATION_ID_PATTERN);
  });

  it("rejects a successful HTTP response for a different intent", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(decisionFor("550e8400-e29b-41d4-a716-446655440099", "request")));
    });
    servers.push(server);
    const result = await runCli(`${JSON.stringify(validIntent)}\n`, { GUARDRAIL_URL: server.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "invalid_response" });
    expect(JSON.parse(result.stdout).outcome).toBeUndefined();
  });

  it("times out stalled evaluate requests without treating them as decisions", async () => {
    const server = await listen(() => undefined);
    servers.push(server);

    const result = await runCli(
      `${JSON.stringify(validIntent)}\n`,
      { GUARDRAIL_URL: server.url },
      50,
    );

    expect(result.exitCode).toBe(1);
    const [line] = result.stdout
      .trim()
      .split("\n")
      .map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(line.error).toBe("timeout");
    expect(line.outcome).toBeUndefined();
  });
});
