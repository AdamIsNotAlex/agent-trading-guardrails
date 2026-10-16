import { inspect } from "node:util";
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  HttpDecisionProviderConfig,
} from "./decision-provider.js";

const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_FAILED = "Decision reviewer request failed.";
const INVALID_RESPONSE = "Decision reviewer response is invalid.";
const INVALID_REQUEST = "Decision reviewer request is invalid.";
const CONTEXT_EXCEEDED = "Decision reviewer request exceeds the Clef context budget.";
const ACCOUNT_ID_PATTERN = /^[0-9a-fA-F]{32}$/;
const CLEF_QUESTION_ID = /^[A-Za-z0-9._-]{1,100}$/;

const DEFAULT_BASE_URL = {
  jev: "https://api.typesafe.ai/v1",
  clef: "https://api.cloudflare.com/client/v4",
  "openai-decisions": "https://api.openai.com/v1",
} as const;

export class HttpDecisionProvider implements DecisionProvider {
  #provider: HttpDecisionProviderConfig["provider"];
  #apiKey: string;
  #model: string;
  #endpoint: string;
  #clefContextLimit?: number;

  constructor(config: HttpDecisionProviderConfig) {
    const apiKey = config.apiKey.trim();
    if (apiKey.length === 0) {
      throw new Error("Decision reviewer API key is required.");
    }
    const model = config.model.trim();
    if (model.length === 0) {
      throw new Error("Decision reviewer model must not be empty.");
    }
    const provider = config.provider;
    if (provider !== "jev" && provider !== "clef" && provider !== "openai-decisions") {
      throw new Error("Unsupported reviewer provider.");
    }

    const configured = config.baseUrl?.trim();
    let parsed: URL;
    try {
      parsed = new URL(configured ? configured : DEFAULT_BASE_URL[provider]);
    } catch {
      throw new Error("Decision reviewer base URL is invalid.");
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname.length === 0 ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new Error("Decision reviewer base URL is invalid.");
    }
    parsed.search = "";
    parsed.hash = "";
    const base = parsed.href.replace(/\/+$/, "");

    if (provider === "clef") {
      const accountId = config.accountId?.trim() ?? "";
      if (accountId.length === 0) {
        throw new Error("Cloudflare account ID is required.");
      }
      if (!ACCOUNT_ID_PATTERN.test(accountId)) {
        throw new Error("Cloudflare account ID is invalid.");
      }
      if (model !== "clef" && model !== "clef-flash") {
        throw new Error("Unsupported Clef model.");
      }
      this.#endpoint = `${base}/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`;
      this.#clefContextLimit = model === "clef" ? 65_536 : 24_576;
    } else if (provider === "jev") {
      this.#endpoint = `${base}/systemone`;
    } else {
      this.#endpoint = `${base}/decisions`;
    }

    this.#provider = provider;
    this.#apiKey = apiKey;
    this.#model = model;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const bound = bindQuestions(request.questions, this.#provider);
    const body =
      this.#provider === "openai-decisions"
        ? encodeOpenAiBody(this.#model, request.input, bound.values())
        : encodeSystemOneBody(this.#model, request.input, bound.values());
    const serializedBody = JSON.stringify(body);
    if (this.#clefContextLimit !== undefined) {
      assertClefContextBudget(serializedBody, bound.values(), this.#clefContextLimit);
    }

    let response: Response;
    try {
      response = await fetch(this.#endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: serializedBody,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error(REQUEST_FAILED);
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // The upstream body may contain secrets; discard without reading it.
      }
      throw new Error(REQUEST_FAILED);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(INVALID_RESPONSE);
    }
    return readDecisionResult(this.#provider, payload, bound);
  }

  [inspect.custom](): string {
    return "HttpDecisionProvider {}";
  }
}

function bindQuestions(
  questions: readonly ChoiceQuestion[],
  provider: HttpDecisionProviderConfig["provider"],
): Map<string, ChoiceQuestion> {
  const bound = new Map<string, ChoiceQuestion>();
  for (const question of questions) {
    if (question.id.length === 0 || bound.has(question.id)) {
      throw new Error(INVALID_REQUEST);
    }
    if (provider === "clef" && !CLEF_QUESTION_ID.test(question.id)) {
      throw new Error(INVALID_REQUEST);
    }
    if (question.instructions.trim() === "") {
      throw new Error(INVALID_REQUEST);
    }
    let choiceCount = 0;
    for (const key of Object.keys(question.choices)) {
      if (key.length === 0) {
        throw new Error(INVALID_REQUEST);
      }
      choiceCount += 1;
    }
    if (choiceCount < 2) {
      throw new Error(INVALID_REQUEST);
    }
    bound.set(question.id, question);
  }
  if (bound.size === 0) {
    throw new Error(INVALID_REQUEST);
  }
  return bound;
}

function encodeSystemOneBody(
  model: string,
  input: string,
  questions: Iterable<ChoiceQuestion>,
): Record<string, unknown> {
  const encoded: Record<string, unknown> = Object.create(null);
  for (const question of questions) {
    encoded[question.id] = {
      type: "choice",
      instructions: question.instructions,
      criteria: Object.assign(Object.create(null) as Record<string, string>, question.choices),
    };
  }
  return { model, state: input, questions: encoded };
}

function encodeOpenAiBody(
  model: string,
  input: string,
  questions: Iterable<ChoiceQuestion>,
): Record<string, unknown> {
  return {
    model,
    input,
    questions: [...questions].map((question) => ({
      type: "choice",
      name: question.id,
      instructions: question.instructions,
      choices: Object.entries(question.choices).map(([value, description]) => ({
        value,
        description,
      })),
    })),
  };
}

function assertClefContextBudget(
  serializedBody: string,
  questions: Iterable<ChoiceQuestion>,
  tokenLimit: number,
): void {
  // Clef's byte-level tokenizer uses at most one token per UTF-8 byte. Count the
  // entire JSON body, including escaped text, instructions, IDs and choices.
  // Reserve additional tokens for its system prompt and per-field/option framing,
  // which are added by the provider rather than represented in the HTTP body.
  let tokenUpperBound = Buffer.byteLength(serializedBody, "utf8") + 1_024;
  for (const question of questions) {
    tokenUpperBound += 128 + 64 * Object.keys(question.choices).length;
  }
  if (tokenUpperBound > tokenLimit) {
    throw new Error(CONTEXT_EXCEEDED);
  }
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readChoiceAnswer(raw: unknown, question: ChoiceQuestion): ChoiceAnswer {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(INVALID_RESPONSE);
  }
  const answer = raw as Record<string, unknown>;
  if (answer.type !== "choice") {
    throw new Error(INVALID_RESPONSE);
  }
  if (typeof answer.choice !== "string" || !Object.hasOwn(question.choices, answer.choice)) {
    throw new Error(INVALID_RESPONSE);
  }
  if (!isUnitInterval(answer.confidence)) {
    throw new Error(INVALID_RESPONSE);
  }
  const rawProbabilities = answer.probabilities;
  if (
    rawProbabilities === null ||
    typeof rawProbabilities !== "object" ||
    Array.isArray(rawProbabilities)
  ) {
    throw new Error(INVALID_RESPONSE);
  }
  const source = rawProbabilities as Record<string, unknown>;
  const allowed = Object.keys(question.choices);
  if (Object.keys(source).length !== allowed.length) {
    throw new Error(INVALID_RESPONSE);
  }
  const probabilities: Record<string, number> = Object.create(null);
  for (const key of allowed) {
    const probability = source[key];
    if (!Object.hasOwn(source, key) || !isUnitInterval(probability)) {
      throw new Error(INVALID_RESPONSE);
    }
    probabilities[key] = probability;
  }
  return { choice: answer.choice, confidence: answer.confidence, probabilities };
}

function readBoundAnswers(
  rawAnswers: Map<string, unknown>,
  bound: Map<string, ChoiceQuestion>,
): Record<string, ChoiceAnswer> {
  if (rawAnswers.size !== bound.size) {
    throw new Error(INVALID_RESPONSE);
  }
  const answers: Record<string, ChoiceAnswer> = Object.create(null);
  for (const [id, question] of bound) {
    if (!rawAnswers.has(id)) {
      throw new Error(INVALID_RESPONSE);
    }
    answers[id] = readChoiceAnswer(rawAnswers.get(id), question);
  }
  return answers;
}

function readOpenAiAnswers(
  payload: Record<string, unknown>,
  bound: Map<string, ChoiceQuestion>,
): Record<string, ChoiceAnswer> {
  if (!Array.isArray(payload.answers)) {
    throw new Error(INVALID_RESPONSE);
  }
  const rawAnswers = new Map<string, unknown>();
  for (const answer of payload.answers) {
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
      throw new Error(INVALID_RESPONSE);
    }
    const entry = answer as Record<string, unknown>;
    if (typeof entry.name !== "string") {
      throw new Error(INVALID_RESPONSE);
    }
    if (entry.type === "refusal" || rawAnswers.has(entry.name) || !bound.has(entry.name)) {
      throw new Error(INVALID_RESPONSE);
    }
    if (!Array.isArray(entry.probabilities)) {
      throw new Error(INVALID_RESPONSE);
    }
    const probabilities: Record<string, unknown> = Object.create(null);
    for (const item of entry.probabilities) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(INVALID_RESPONSE);
      }
      const probability = item as Record<string, unknown>;
      if (
        typeof probability.value !== "string" ||
        Object.hasOwn(probabilities, probability.value)
      ) {
        throw new Error(INVALID_RESPONSE);
      }
      probabilities[probability.value] = probability.probability;
    }
    rawAnswers.set(entry.name, {
      type: entry.type,
      choice: entry.choice,
      confidence: entry.confidence,
      probabilities,
    });
  }
  return readBoundAnswers(rawAnswers, bound);
}

function unwrapClefResult(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(INVALID_RESPONSE);
  }
  const envelope = payload as Record<string, unknown>;
  if (!Object.hasOwn(envelope, "success")) {
    throw new Error(INVALID_RESPONSE);
  }
  if (envelope.success !== true) {
    throw new Error(REQUEST_FAILED);
  }
  if (
    envelope.result === null ||
    typeof envelope.result !== "object" ||
    Array.isArray(envelope.result)
  ) {
    throw new Error(INVALID_RESPONSE);
  }
  return envelope.result;
}

function readDecisionResult(
  provider: HttpDecisionProviderConfig["provider"],
  payload: unknown,
  bound: Map<string, ChoiceQuestion>,
): DecisionResult {
  if (provider === "clef") {
    payload = unwrapClefResult(payload);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(INVALID_RESPONSE);
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.model !== "string" || body.model.trim() === "") {
    throw new Error(INVALID_RESPONSE);
  }
  if (provider === "openai-decisions") {
    return { model: body.model, answers: readOpenAiAnswers(body, bound) };
  }
  if (body.answers === null || typeof body.answers !== "object" || Array.isArray(body.answers)) {
    throw new Error(INVALID_RESPONSE);
  }
  return {
    model: body.model,
    answers: readBoundAnswers(
      new Map(Object.entries(body.answers as Record<string, unknown>)),
      bound,
    ),
  };
}
