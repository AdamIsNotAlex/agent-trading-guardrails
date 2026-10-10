import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { ExecutionBroker } from "@guardrails/broker";
import { TradingIntent } from "@guardrails/schemas";
import { getRequestCorrelationId, HttpError, readJsonBody, sendJson } from "@guardrails/service";
import { z } from "zod";

const approvalFields = {
  intentId: z.string().uuid(),
  correlationId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  intent: TradingIntent,
  decidedAt: z.string().datetime(),
  decisionToken: z.string().regex(/^[a-f0-9]{64}$/),
};
const approvalSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...approvalFields,
    outcome: z.literal("allow"),
    approvalId: z.string().uuid().optional(),
  }),
  z.object({
    ...approvalFields,
    outcome: z.literal("needs_human"),
    approvalId: z.string().uuid(),
  }),
]);

export function createBrokerServer(
  broker: ExecutionBroker,
  executionMode: "paper" | "binance-testnet" | "binance-live",
) {
  return createServer((request, response) => {
    let correlationId = randomUUID() as string;
    const handle = async () => {
      try {
        correlationId = getRequestCorrelationId(request);
        response.setHeader("x-correlation-id", correlationId);
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        const method = path === "/health" ? "GET" : path === "/execute" ? "POST" : null;
        if (!method) throw new HttpError(404, "Route not found.");
        if (request.method !== method) {
          response.setHeader("allow", method);
          throw new HttpError(405, "Method not allowed.");
        }
        if (path === "/health") {
          sendJson(response, 200, { status: "ok", executionMode });
          return;
        }
        const parsed = approvalSchema.safeParse(await readJsonBody(request));
        if (!parsed.success) throw new HttpError(400, "Invalid execution approval.");
        // The signed decision ID must not be replaced by this HTTP request's ID.
        sendJson(response, 200, await broker.execute(parsed.data));
      } catch (error) {
        response.setHeader("x-correlation-id", correlationId);
        sendJson(response, error instanceof HttpError ? error.statusCode : 500, {
          error: error instanceof HttpError ? error.message : "Internal server error.",
          correlationId,
        });
      } finally {
        request.resume();
      }
    };
    void handle();
  });
}
