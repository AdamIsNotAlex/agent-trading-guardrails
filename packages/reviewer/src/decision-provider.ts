export interface ChoiceQuestion {
  id: string;
  instructions: string;
  choices: Readonly<Record<string, string>>;
}

export interface DecisionRequest {
  input: string;
  questions: readonly ChoiceQuestion[];
}

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Readonly<Record<string, number>>;
}

export interface DecisionResult {
  model: string;
  answers: Readonly<Record<string, ChoiceAnswer>>;
}

/** A bounded classifier, not a text-completion API or an execution authority. */
export interface DecisionProvider {
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

export interface HttpDecisionProviderConfig {
  provider: "jev" | "clef" | "openai-decisions";
  apiKey: string;
  model: string;
  baseUrl?: string;
  accountId?: string;
}
