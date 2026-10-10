import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TradingIntent } from "@guardrails/schemas";
import { generateCorrelationId } from "./correlation.js";
import type { GuardrailService } from "./service.js";

const MAX_JSON_BODY_BYTES = 1_048_576;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export function getRequestCorrelationId(request: IncomingMessage): string {
  const raw = request.headers["x-correlation-id"];
  if (raw === undefined) {
    return generateCorrelationId();
  }
  if (typeof raw !== "string" || !CORRELATION_ID_PATTERN.test(raw)) {
    throw new HttpError(400, "Invalid correlation ID.");
  }
  return raw;
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentTypeHeader = request.headers["content-type"];
  const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(415, "Unsupported media type.");
  }

  const lengthHeader = request.headers["content-length"];
  const lengthRaw = Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader;
  if (lengthRaw !== undefined && /^[0-9]+$/.test(lengthRaw)) {
    const declaredLength = Number(lengthRaw);
    if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, "Request body too large.");
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_JSON_BODY_BYTES) {
      chunks.length = 0;
      throw new HttpError(413, "Request body too large.");
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks, size).toString("utf8");
  if (text.length === 0) {
    throw new HttpError(400, "Malformed JSON body.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "Malformed JSON body.");
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body) ?? "null";
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function createGuardrailServer(
  service: Pick<GuardrailService, "health" | "evaluate">,
): Server {
  return createServer((request, response) => {
    let correlationId = generateCorrelationId();
    const handle = async () => {
      try {
        correlationId = getRequestCorrelationId(request);
        response.setHeader("x-correlation-id", correlationId);
        let path: string;
        try {
          path = new URL(request.url ?? "/", "http://localhost").pathname;
        } catch {
          throw new HttpError(404, "Route not found.");
        }
        if (path === "/health") {
          if (request.method !== "GET") {
            response.setHeader("allow", "GET");
            throw new HttpError(405, "Method not allowed.");
          }
          const health = await service.health();
          sendJson(response, health.status === "ok" ? 200 : 503, health);
          return;
        }
        if (path === "/evaluate" || path === "/dry-run") {
          if (request.method !== "POST") {
            response.setHeader("allow", "POST");
            throw new HttpError(405, "Method not allowed.");
          }
          const parsed = TradingIntent.safeParse(await readJsonBody(request));
          if (!parsed.success) {
            throw new HttpError(400, "Invalid trading intent.");
          }
          sendJson(
            response,
            200,
            await service.evaluate(parsed.data, {
              correlationId,
              ...(path === "/dry-run" ? { dryRun: true as const } : {}),
            }),
          );
          return;
        }
        throw new HttpError(404, "Route not found.");
      } catch (error) {
        try {
          if (response.writableEnded || response.destroyed) {
            return;
          }
          response.setHeader("x-correlation-id", correlationId);
          sendJson(response, error instanceof HttpError ? error.statusCode : 500, {
            error: error instanceof HttpError ? error.message : "Internal server error.",
            correlationId,
          });
        } catch {
          if (!response.destroyed) {
            response.destroy();
          }
        }
      } finally {
        request.resume();
      }
    };
    void handle();
  });
}
