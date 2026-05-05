import OpenAI from "openai";
import type { LlmProvider } from "./interfaces.js";

export interface OpenAiLlmProviderConfig {
  apiKey: string;
  model?: string;
}

export class OpenAiLlmProvider implements LlmProvider {
  #client: OpenAI;
  #model: string;

  constructor(config: OpenAiLlmProviderConfig) {
    const apiKey = config.apiKey.trim();
    if (apiKey.length === 0) {
      throw new Error("OpenAI API key is required.");
    }
    this.#client = new OpenAI({ apiKey });
    this.#model = config.model ?? "gpt-5.5";
  }

  async complete(prompt: string): Promise<string> {
    try {
      const completion = await this.#client.chat.completions.create({
        model: this.#model,
        messages: [{ role: "user", content: prompt }],
      });
      const content = completion.choices[0]?.message.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("OpenAI reviewer response did not include text content.");
      }
      return content;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message === "OpenAI reviewer response did not include text content."
      ) {
        throw err;
      }
      throw new Error("OpenAI reviewer request failed.");
    }
  }
}
