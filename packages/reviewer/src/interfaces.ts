export interface LlmProvider {
  complete(prompt: string): Promise<string>;
}

export interface ReviewerConfig {
  model: string;
  provider: string;
}
