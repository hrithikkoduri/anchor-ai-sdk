/**
 * LLM factory — options in, client out.
 *
 * No environment access here (publishable-ready rule): the consumer passes
 * plain options; the app owns configuration. apps/harness calls this with
 * `cfg.llm` straight from its config module.
 */
import { OpenAICompatibleClient } from "./openai.js";
import type { LLMClient } from "./types.js";

export * from "./types.js";
export { OpenAICompatibleClient, LLMApiError } from "./openai.js";
export type { OpenAICompatibleOptions } from "./openai.js";

export interface LLMOptions {
  baseUrl: string;
  apiKey: string | undefined;
  model: string | undefined;
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
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
  });
}
