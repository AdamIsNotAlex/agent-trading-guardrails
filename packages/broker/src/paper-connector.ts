import { randomUUID } from "node:crypto";
import type { TradingIntent } from "@guardrails/schemas";
import type {
  BeforeConnectorSideEffect,
  ConnectorExecutionResult,
  ExecutionConnector,
} from "./interfaces.js";

export class PaperExecutionConnector implements ExecutionConnector {
  async execute(
    intent: TradingIntent,
    beforeSideEffect?: BeforeConnectorSideEffect,
  ): Promise<ConnectorExecutionResult> {
    if (intent.action === "cex.place_order" || intent.action === "cex.cancel_order") {
      beforeSideEffect?.();
      return { orderId: `paper-${randomUUID().slice(0, 8)}` };
    }
    if (intent.action === "onchain.request_signature") {
      beforeSideEffect?.();
      return { transactionHash: `0xpaper${randomUUID().replace(/-/g, "").slice(0, 56)}` };
    }
    throw new Error(`Paper connector does not execute ${intent.action}.`);
  }

  async revalidate(intent: TradingIntent): Promise<{ passed: boolean; reason?: string }> {
    if (
      intent.action === "cex.place_order" ||
      intent.action === "cex.cancel_order" ||
      intent.action === "onchain.request_signature"
    ) {
      return { passed: true };
    }
    return { passed: false, reason: `Paper connector does not execute ${intent.action}.` };
  }
}
