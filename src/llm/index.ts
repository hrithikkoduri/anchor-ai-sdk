/**
 * LLM factory — options in, client out.
 *
 * No environment access here (publishable-ready rule): the consumer passes
 * plain options — an app hands in its own config object, this module never
 * looks one up.
 */
import {
  OpenAICompatibleClient,
  type OpenAICompatibleOptions,
} from "./openai-compatible.js";
import type { LLMClient } from "./types.js";

export * from "./types.js";
export * from "./structured.js";
export * from "./catalog.js";
export { OpenAICompatibleClient, LLMApiError } from "./openai-compatible.js";
export type { OpenAICompatibleOptions } from "./openai-compatible.js";

export interface LLMOptions {
  baseUrl: string;
  apiKey: string | undefined;
  model: string | undefined;
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
  /** USD per million cached input tokens (prompt-cache reads). */
  priceCacheReadPerMTok?: number;
  /** Ask the provider for a usage block carrying the real cost (OpenRouter). */
  includeUsageCost?: boolean;
  /** Emit explicit prompt-cache breakpoints for providers that support them. */
  promptCache?: OpenAICompatibleOptions["promptCache"];
  /** Default reasoning budget; per-request `reasoningEffort` wins. */
  reasoningEffort?: OpenAICompatibleOptions["reasoningEffort"];
  /** Wire shape for reasoning effort; inferred from `baseUrl` when unset. */
  reasoningFormat?: OpenAICompatibleOptions["reasoningFormat"];
  /** Replay reasoning during tool loops; default `false` (off). */
  reasoningPassback?: OpenAICompatibleOptions["reasoningPassback"];
}

export function createLLMClient(opts: LLMOptions): LLMClient {
  if (!opts.apiKey) {
    throw new Error(
      "LLM_API_KEY is not set — add it to .env (any OpenAI-compatible provider; OpenRouter by default)",
    );
  }
  if (!opts.model) {
    throw new Error("LLM_MODEL is not set — e.g. deepseek/deepseek-v4.1-flash");
  }
  return new OpenAICompatibleClient({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    priceInPerMTok: opts.priceInPerMTok,
    priceOutPerMTok: opts.priceOutPerMTok,
    priceCacheReadPerMTok: opts.priceCacheReadPerMTok,
    includeUsageCost: opts.includeUsageCost,
    promptCache: opts.promptCache,
    reasoningEffort: opts.reasoningEffort,
    reasoningFormat: opts.reasoningFormat,
    reasoningPassback: opts.reasoningPassback,
  });
}
