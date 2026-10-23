/**
 * OpenAI-compatible LLM client — one POST to /chat/completions.
 *
 * ONE wire path: every request streams (`stream: true`); `complete()` is a
 * thin aggregate over `stream()`. A single parser (SSE chunks + tool-call
 * fragment assembly) can't drift against itself, and token-level deltas feed
 * the trace and the chat SSE (step 18) for free.
 *
 * Deliberately raw `fetch`, no SDK: the protocol is stable, and we need our
 * own retry policy, latency measurement, and cost accounting for the trace
 * and the $ budgets. Works with OpenRouter, OpenAI, Groq, Together, local
 * llama.cpp servers — anything speaking the same shape.
 *
 * Retry policy: 429 and 5xx are retried with exponential backoff + jitter
 * while ESTABLISHING the call; other 4xx are deterministic and throw
 * immediately (a bad key retried three times is just a slower error). A
 * stream that dies mid-flight throws — the loop's guardrails treat the step
 * as failed, and the run's budget accounting still sees partial usage where
 * the provider reported it.
 */
import type {
  LLMClient,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
  LLMUsage,
  PromptCacheSetting,
  ReasoningEffort,
} from "./types.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** USD per million tokens — enables costUsd accounting when both are set. */
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
  /**
   * USD per million CACHED input tokens (prompt-cache reads). Falls back to
   * priceInPerMTok when unset — cache hits then just cost the same as misses.
   */
  priceCacheReadPerMTok?: number;
  /**
   * Ask the provider for a usage block that includes the real cost
   * (OpenRouter's `usage: { include: true }`). Provider-reported cost beats
   * the price table whenever it is present.
   */
  includeUsageCost?: boolean;
  /**
   * Emit explicit prompt-cache breakpoints. `true` marks the stable system
   * prefix; the engine supplies additional stable-prefix indexes. Use only
   * with providers that accept Anthropic-style `cache_control` fields.
   */
  promptCache?: PromptCacheSetting;
  /**
   * Default reasoning budget for calls that do not set one per request.
   * Ignored by non-reasoning models.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Wire shape for `reasoningEffort`:
   * - `"openrouter"` sends `reasoning: { effort }`
   * - `"openai"` sends `reasoning_effort`
   *
   * Default: inferred from `baseUrl` (`openrouter.ai` → openrouter, otherwise
   * openai). Set it explicitly for a gateway that speaks the other shape.
   */
  reasoningFormat?: "openrouter" | "openai";
  /** Test seams. */
  fetchImpl?: typeof fetch;
  retryBaseDelayMs?: number;
  maxRetries?: number;
}

export class LLMApiError extends Error {
  constructor(
    readonly status: number,
    readonly bodyExcerpt: string,
  ) {
    super(`LLM API error ${status}: ${bodyExcerpt}`);
    this.name = "LLMApiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One SSE chunk's shape — loosely typed; providers differ at the edges. */
interface ChatChunk {
  model?: string;
  /** OpenRouter reports the upstream; a direct API usually omits this. */
  provider?: string | { name?: string };
  choices?: Array<{
    delta?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      reasoning_details?: Array<{
        type?: string;
        text?: string;
        summary?: string;
      }>;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
    /** OpenRouter, with usage.include: the real cost of this call, in USD. */
    cost?: number;
  } | null;
}

interface StreamState {
  text: string;
  reasoning: string;
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  usage?: NonNullable<ChatChunk["usage"]>;
  model?: string;
  provider?: string;
  finishReason?: string;
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  // Some providers send an array of parts (multimodal era); keep the text parts.
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: unknown })?.text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}

/**
 * Our LLMMessage shape carries tool calls flat ({id, name, arguments}); the
 * wire wants the OpenAI nesting ({id, type:"function", function:{...}}), and
 * tool results must reference tool_call_id. Convert at the boundary — the
 * rest of the codebase never sees wire shapes.
 */
interface WireCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

function cacheControlFor(
  setting: PromptCacheSetting | undefined,
): WireCacheControl | undefined {
  if (!setting) return undefined;
  if (setting === true) return { type: "ephemeral" };
  return {
    type: "ephemeral",
    ...(setting.ttl ? { ttl: setting.ttl } : {}),
  };
}

function textWithCache(
  text: string,
  cache: WireCacheControl | undefined,
): unknown {
  return cache
    ? [{ type: "text", text, cache_control: cache }]
    : text;
}

function toWireMessages(
  messages: LLMMessage[],
  promptCache?: PromptCacheSetting,
  breakpoints?: number[],
): unknown[] {
  const cache = cacheControlFor(promptCache);
  const marked = new Set(
    cache ? (breakpoints?.length ? breakpoints : [0]) : [],
  );
  return messages.map((m, index) => {
    const marker = marked.has(index) ? cache : undefined;
    if (m.role === "assistant") {
      const out: Record<string, unknown> = {
        role: "assistant",
        content: m.content
          ? textWithCache(m.content, marker)
          : (m.content ?? ""),
      };
      if (m.tool_calls && m.tool_calls.length > 0) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return out;
    }
    if (m.role === "tool") {
      // Tool results stay strings for OpenAI-compatible gateways. A cache
      // breakpoint on a tool result is not portable, so the engine chooses
      // the nearest preceding text message instead.
      return {
        role: "tool",
        tool_call_id: m.tool_call_id,
        content: m.content ?? "",
      };
    }
    if (m.role === "user" && m.images && m.images.length > 0) {
      const parts: Array<Record<string, unknown>> = [
        ...(m.content ? [{ type: "text", text: m.content }] : []),
        ...m.images.map((image) => ({
          type: "image_url",
          image_url: { url: image.url },
        })),
      ];
      if (marker && parts.length > 0) {
        parts[parts.length - 1] = {
          ...parts[parts.length - 1]!,
          cache_control: marker,
        };
      }
      return { role: "user", content: parts };
    }
    return {
      role: m.role,
      content: textWithCache(m.content ?? "", marker),
    };
  });
}

export class OpenAICompatibleClient implements LLMClient {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async complete(
    req: LLMRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<LLMResponse> {
    return this.stream(req, () => undefined, opts);
  }

  async stream(
    req: LLMRequest,
    onDelta: (delta: string) => void,
    callOpts: {
      signal?: AbortSignal;
      onReasoning?: (delta: string) => void;
    } = {},
  ): Promise<LLMResponse> {
    const started = Date.now();

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: toWireMessages(
        req.messages,
        this.opts.promptCache,
        req.cacheBreakpoints,
      ),
      stream: true,
      stream_options: { include_usage: true },
    };
    // OpenRouter bills per request and can report the real cost in the usage
    // block; ask for it so accounting needs no price table.
    if (this.opts.includeUsageCost) body.usage = { include: true };
    if (req.tools && req.tools.length > 0) body.tools = req.tools;
    if (req.responseFormat) {
      body.response_format =
        req.responseFormat.type === "json_object"
          ? { type: "json_object" }
          : {
              type: "json_schema",
              json_schema: {
                name: req.responseFormat.name,
                schema: req.responseFormat.schema,
                strict: req.responseFormat.strict ?? true,
                ...(req.responseFormat.description
                  ? { description: req.responseFormat.description }
                  : {}),
              },
            };
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.seed !== undefined) body.seed = req.seed;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    const reasoningEffort =
      req.reasoningEffort ?? this.opts.reasoningEffort;
    if (reasoningEffort !== undefined) {
      const format =
        this.opts.reasoningFormat ??
        (/openrouter\.ai/i.test(this.opts.baseUrl) ? "openrouter" : "openai");
      if (format === "openrouter") body.reasoning = { effort: reasoningEffort };
      else body.reasoning_effort = reasoningEffort;
    }

    // --- establish the call (this part is retried) --------------------------
    let res: Response | undefined;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay =
          (this.opts.retryBaseDelayMs ?? 1000) * 2 ** (attempt - 1) +
          Math.random() * 250;
        await sleep(delay);
      }
      try {
        const candidate = await this.fetchImpl(
          `${this.opts.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.opts.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal: callOpts.signal,
          },
        );
        if (candidate.ok) {
          res = candidate;
          break;
        }
        const excerpt = (await candidate.text()).slice(0, 400);
        const retryable = candidate.status === 429 || candidate.status >= 500;
        if (!retryable) throw new LLMApiError(candidate.status, excerpt);
        lastError = new LLMApiError(candidate.status, excerpt);
      } catch (err) {
        if (
          err instanceof LLMApiError &&
          err.status !== 429 &&
          err.status < 500
        )
          throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (!res) throw lastError ?? new Error("LLM request failed after retries");
    if (!res.body) throw new Error("LLM response has no body to stream");

    // --- consume the SSE stream (not retried; mid-flight death is a failure) -
    const state: StreamState = {
      text: "",
      reasoning: "",
      toolCalls: new Map(),
    };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return; // comments/keep-alives skipped
      const payload = trimmed.slice(5).trim();
      if (payload === "" || payload === "[DONE]") return;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(payload) as ChatChunk;
      } catch {
        return; // tolerate a malformed fragment rather than killing the turn
      }
      this.applyChunk(chunk, state, onDelta, callOpts.onReasoning);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer !== "") handleLine(buffer); // last line without trailing newline

    return this.finishResponse(state, started);
  }

  private applyChunk(
    chunk: ChatChunk,
    state: StreamState,
    onDelta: (delta: string) => void,
    onReasoning?: (delta: string) => void,
  ): void {
    if (chunk.model) state.model = chunk.model;
    const provider =
      typeof chunk.provider === "string"
        ? chunk.provider
        : chunk.provider?.name;
    if (provider) state.provider = provider;
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta ?? {};
      const reasoning =
        normalizeContent(delta.reasoning ?? delta.reasoning_content) ||
        (delta.reasoning_details ?? [])
          .filter((detail) =>
            ["reasoning.text", "reasoning.summary"].includes(detail.type ?? ""),
          )
          .map((detail) => detail.summary ?? detail.text ?? "")
          .join("");
      if (reasoning) {
        state.reasoning += reasoning;
        onReasoning?.(reasoning);
      }
      const piece = normalizeContent(delta.content);
      if (piece !== "") {
        state.text += piece;
        onDelta(piece);
      }
      for (const tc of delta.tool_calls ?? []) {
        // Tool arguments arrive FRAGMENTED across deltas — accumulate by index.
        const index = tc.index ?? 0;
        const entry = state.toolCalls.get(index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        state.toolCalls.set(index, entry);
      }
      if (choice.finish_reason) state.finishReason = choice.finish_reason;
    }
    if (chunk.usage) state.usage = chunk.usage;
  }

  private finishResponse(state: StreamState, started: number): LLMResponse {
    const toolCalls: LLMToolCall[] = [...state.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, tc]) => ({
        id:
          tc.id !== ""
            ? tc.id
            : `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.name,
        arguments: tc.arguments === "" ? "{}" : tc.arguments,
      }))
      .filter((tc) => tc.name !== "");

    const promptTokens = state.usage?.prompt_tokens ?? 0;
    const completionTokens = state.usage?.completion_tokens ?? 0;
    const cachedTokens = state.usage?.prompt_tokens_details?.cached_tokens;
    const usage: LLMUsage = {
      promptTokens,
      completionTokens,
      totalTokens: state.usage?.total_tokens ?? promptTokens + completionTokens,
    };
    const reasoningTokens =
      state.usage?.completion_tokens_details?.reasoning_tokens;
    if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
    if (cachedTokens !== undefined && cachedTokens > 0)
      usage.cachedTokens = cachedTokens;
    // Provider-reported cost (OpenRouter with usage.include) is the truth when
    // present; otherwise compute it, billing the cached input share at the
    // cache-read rate — prompt-cache reads are ~25x cheaper on deepseek.
    const reportedCost = state.usage?.cost;
    if (typeof reportedCost === "number") {
      usage.costUsd = reportedCost;
    } else if (
      this.opts.priceInPerMTok !== undefined &&
      this.opts.priceOutPerMTok !== undefined
    ) {
      const cached = Math.min(cachedTokens ?? 0, promptTokens);
      const uncached = promptTokens - cached;
      const cacheReadPrice =
        this.opts.priceCacheReadPerMTok ?? this.opts.priceInPerMTok;
      usage.costUsd =
        (uncached / 1_000_000) * this.opts.priceInPerMTok +
        (cached / 1_000_000) * cacheReadPrice +
        (completionTokens / 1_000_000) * this.opts.priceOutPerMTok;
    }

    return {
      text: state.text,
      ...(state.reasoning ? { reasoning: state.reasoning } : {}),
      toolCalls,
      usage,
      model: state.model ?? this.opts.model,
      ...(state.provider ? { provider: state.provider } : {}),
      finishReason: state.finishReason,
      latencyMs: Date.now() - started,
    };
  }
}
