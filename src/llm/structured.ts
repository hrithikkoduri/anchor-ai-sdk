/**
 * Structured output helper — one place for internal calls that need a JSON
 * object (ledger compiler, verifier, evaluators) instead of prose.
 *
 * The request carries a JSON Schema; the provider is asked for a schema-bound
 * response. Parsing/validation is explicit and always fails loudly, so a
 * malformed decision can never be mistaken for an allow.
 */
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "./types.js";

export interface StructuredRequest<T> {
  messages: LLMRequest["messages"];
  name: string;
  schema: Record<string, unknown>;
  parse: (value: unknown) => T;
  description?: string;
  strict?: boolean;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: LLMRequest["reasoningEffort"];
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  value: T;
  response: LLMResponse;
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

/**
 * Ask the client for a schema-bound JSON object, parse it, and validate it
 * with the caller's parser. The parser is the type guard: if it throws, the
 * result is rejected; this helper never coerces or repairs JSON with regex.
 */
export async function completeStructured<T>(
  llm: LLMClient,
  req: StructuredRequest<T>,
): Promise<StructuredResult<T>> {
  const response = await llm.complete(
    {
      messages: req.messages,
      responseFormat: {
        type: "json_schema",
        name: req.name,
        schema: req.schema,
        strict: req.strict ?? true,
        ...(req.description ? { description: req.description } : {}),
      },
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.reasoningEffort !== undefined
        ? { reasoningEffort: req.reasoningEffort }
        : {}),
    },
    req.signal ? { signal: req.signal } : undefined,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new StructuredOutputError(
      `structured response for "${req.name}" was not valid JSON`,
      response.text,
    );
  }

  try {
    return { value: req.parse(parsed), response };
  } catch (error) {
    throw new StructuredOutputError(
      `structured response for "${req.name}" failed validation: ${
        error instanceof Error ? error.message : String(error)
      }`,
      response.text,
    );
  }
}
