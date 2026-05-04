import type { ApprovalNotifier, ApprovalRequest } from "./interfaces.js";

export class ConsoleNotifier implements ApprovalNotifier {
  async notify(request: ApprovalRequest): Promise<void> {
    console.log(
      `[APPROVAL NEEDED] ${request.approvalId.slice(0, 8)} — ${request.action} ${request.resource} (${request.escalationReason})`,
    );
  }
}

// Adapter designs for future implementation:

export interface WebUiAdapterConfig {
  port: number;
  host: string;
}

export interface SlackAdapterConfig {
  webhookUrl: string;
  channel: string;
}

export interface TelegramAdapterConfig {
  botToken: string;
  chatId: string;
}

export interface DiscordAdapterConfig {
  webhookUrl: string;
}

export interface WhatsAppAdapterConfig {
  apiUrl: string;
  phoneNumber: string;
}

export interface SignalAdapterConfig {
  apiUrl: string;
  recipientNumber: string;
}
