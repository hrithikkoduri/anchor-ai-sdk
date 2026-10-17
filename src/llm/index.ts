/**
 * LLM factory — config in, client out. Everything above the agent loop calls
 * this; nothing else knows which provider is behind the interface.
 */
import type { HarnessConfig } from "../config.js";
import { OpenAICompatibleClient } from "./openai.js";
import type { LLMClient } from "./types.js";

export * from "./types.js";
export { OpenAICompatibleClient, LLMApiError } from "./openai.js";

export function createLLMClient(cfg: HarnessConfig): LLMClient {
  if (!cfg.llm.apiKey) {
    throw new Error(
      "LLM_API_KEY is not set — add it to .env (any OpenAI-compatible provider; OpenRouter by default)",
    );
  }
  if (!cfg.llm.model) {
    throw new Error("LLM_MODEL is not set — e.g. deepseek/deepseek-v4.1-flash");
  }
  return new OpenAICompatibleClient({
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
    priceInPerMTok: cfg.llm.priceInPerMTok,
    priceOutPerMTok: cfg.llm.priceOutPerMTok,
  });
}
