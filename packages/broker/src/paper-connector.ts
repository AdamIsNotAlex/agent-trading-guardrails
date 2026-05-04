import { randomUUID } from "node:crypto";
import type { TradingIntent } from "@guardrails/schemas";
import type { ExecutionConnector } from "./interfaces.js";

export class PaperExecutionConnector implements ExecutionConnector {
  async execute(intent: TradingIntent): Promise<{ orderId?: string; transactionHash?: string }> {
    if (intent.action === "cex.place_order" || intent.action === "cex.cancel_order") {
      return { orderId: `paper-${randomUUID().slice(0, 8)}` };
    }
    if (intent.action === "onchain.request_signature") {
      return { transactionHash: `0xpaper${randomUUID().replace(/-/g, "").slice(0, 56)}` };
    }
    return {};
  }

  async revalidate(_intent: TradingIntent): Promise<{ passed: boolean; reason?: string }> {
    return { passed: true };
  }
}
