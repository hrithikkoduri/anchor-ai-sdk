/**
 * The LLM boundary — one interface, one job: take a conversation + tool
 * definitions, return text and/or tool calls plus usage.
 *
 * Everything above (the agent loop) depends only on this; providers are
 * swappable by construction. Messages follow the OpenAI chat format — the
 * de-facto standard that OpenRouter, OpenAI, and most gateways speak.
 */
export interface LLMToolCall {
  /** Provider-assigned id; tool results must reference it. */
  id: string;
  name: string;
  /** Raw JSON string exactly as emitted (the loop validates before use). */
  arguments: string;
}

export interface ImageAttachment {
  /** Consumer-assigned stable id; also useful for storage and traces. */
  id: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  /** A signed HTTPS URL or a data URI the provider can read. */
  url: string;
  width?: number;
  height?: number;
  sha256?: string;
  alt?: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** null is legal for an assistant message that is pure tool calls. */
  content: string | null;
  /** User messages only; provider adapters map these to image parts. */
  images?: ImageAttachment[];
  /**
   * Runtime provenance. Never serialized to the provider.
   * - `engine`: a nudge/checkpoint. Dropped from the persisted thread.
   * - `runtime`: a fact the run learned (a background job's result). Kept in
   *   the thread so a resumed run has it, but consumers may hide it in the UI.
   */
  origin?: "engine" | "runtime";
  /** assistant messages only */
  tool_calls?: LLMToolCall[];
  /** tool messages only — which call this result answers */
  tool_call_id?: string;
  /**
   * Assistant messages only: the model's reasoning for this turn, kept so a
   * tool loop can replay it. Set only when the client's `reasoningPassback`
   * is on, sent only by such a client, and never persisted to a thread.
   */
  reasoning?: string;
  /** Assistant messages only: the provider's structured reasoning, verbatim. */
  reasoningDetails?: unknown[];
}

/** OpenAI-style function definition — built from our Tool definitions. */
export interface LLMToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider-reported reasoning tokens (already included in completionTokens). */
  reasoningTokens?: number;
  /** Input tokens served from the provider's prompt cache (already included in promptTokens). */
  cachedTokens?: number;
  /** Computed from configured pricing; undefined when pricing is unknown. */
  costUsd?: number;
}

export interface LLMResponse {
  text: string;
  /** Reasoning text explicitly returned by the provider, when available. */
  reasoning?: string;
  /**
   * Structured reasoning blocks (OpenRouter `reasoning_details`), merged from
   * the stream, when the provider returned any.
   */
  reasoningDetails?: unknown[];
  toolCalls: LLMToolCall[];
  usage: LLMUsage;
  model: string;
  /** Upstream name, when the gateway reports one. Absent on a direct API. */
  provider?: string;
  finishReason?: string;
  latencyMs: number;
}

/**
 * How an assistant turn's reasoning is replayed on later requests:
 * - `"deepseek"` sends `reasoning_content` (DeepSeek's thinking-with-tools API)
 * - `"openrouter"` sends `reasoning_details` verbatim, else `reasoning`
 * - `false` sends nothing (the default)
 */
export type ReasoningPassback = "deepseek" | "openrouter" | false;

/** Provider-normalized reasoning budget (OpenRouter/OpenAI vocabulary). */
export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * Provider-neutral structured output request. The OpenAI-compatible adapter
 * maps this to `response_format`; providers that support strict JSON Schema
 * return a JSON object directly instead of prose that callers must parse.
 */
export type LLMResponseFormat =
  | {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
      description?: string;
    }
  | { type: "json_object" };

/**
 * Opt-in provider prompt caching. The adapter emits Anthropic-style
 * `cache_control: { type: "ephemeral" }` markers; enable it only for a
 * provider/model that understands them.
 */
export interface PromptCacheOptions {
  /** Cache lifetime when the provider supports an explicit TTL. */
  ttl?: "5m" | "1h";
}
export type PromptCacheSetting = boolean | PromptCacheOptions;

export interface LLMRequest {
  messages: LLMMessage[];
  tools?: LLMToolDef[];
  /**
   * Host-computed 0-based message indexes that end a stable prefix. The
   * engine supplies these; custom clients may ignore them. The adapter emits
   * markers only when `promptCache` is enabled on the client.
   */
  cacheBreakpoints?: number[];
  /** Ask for a structured response instead of free-form text. */
  responseFormat?: LLMResponseFormat;
  temperature?: number;
  /** Fixed sample, when the provider supports it. */
  seed?: number;
  maxTokens?: number;
  /**
   * How much reasoning to spend on this call. Sent as OpenRouter's
   * `reasoning: { effort }` or OpenAI's `reasoning_effort` (see
   * `OpenAICompatibleOptions.reasoningFormat`).
   */
  reasoningEffort?: ReasoningEffort;
}

export interface LLMClient {
  readonly model: string;
  /**
   * Whether this client replays reasoning (see `ReasoningPassback`). The
   * engine keeps reasoning on assistant messages only when this is set.
   */
  readonly reasoningPassback?: ReasoningPassback;
  complete(
    req: LLMRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<LLMResponse>;
  /**
   * The same call, streamed: `onDelta` receives text fragments as they
   * arrive; the resolved response is the full aggregate. `complete()` is
   * exactly `stream()` with a no-op delta handler.
   */
  stream(
    req: LLMRequest,
    onDelta: (delta: string) => void,
    opts?: { signal?: AbortSignal; onReasoning?: (delta: string) => void },
  ): Promise<LLMResponse>;
}
