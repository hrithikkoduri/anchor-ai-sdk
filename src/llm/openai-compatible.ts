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
import type { LLMClient, LLMRequest, LLMResponse, LLMToolCall, LLMUsage } from "./types.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** USD per million tokens — enables costUsd accounting when both are set. */
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
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
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

interface StreamState {
  text: string;
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
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

export class OpenAICompatibleClient implements LLMClient {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async complete(req: LLMRequest, opts: { signal?: AbortSignal } = {}): Promise<LLMResponse> {
    return this.stream(req, () => undefined, opts);
  }

  async stream(
    req: LLMRequest,
    onDelta: (delta: string) => void,
    callOpts: { signal?: AbortSignal } = {},
  ): Promise<LLMResponse> {
    const started = Date.now();

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools && req.tools.length > 0) body.tools = req.tools;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    // --- establish the call (this part is retried) --------------------------
    let res: Response | undefined;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = (this.opts.retryBaseDelayMs ?? 1000) * 2 ** (attempt - 1) + Math.random() * 250;
        await sleep(delay);
      }
      try {
        const candidate = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: callOpts.signal,
        });
        if (candidate.ok) {
          res = candidate;
          break;
        }
        const excerpt = (await candidate.text()).slice(0, 400);
        const retryable = candidate.status === 429 || candidate.status >= 500;
        if (!retryable) throw new LLMApiError(candidate.status, excerpt);
        lastError = new LLMApiError(candidate.status, excerpt);
      } catch (err) {
        if (err instanceof LLMApiError && err.status !== 429 && err.status < 500) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (!res) throw lastError ?? new Error("LLM request failed after retries");
    if (!res.body) throw new Error("LLM response has no body to stream");

    // --- consume the SSE stream (not retried; mid-flight death is a failure) -
    const state: StreamState = { text: "", toolCalls: new Map() };
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
      this.applyChunk(chunk, state, onDelta);
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

  private applyChunk(chunk: ChatChunk, state: StreamState, onDelta: (delta: string) => void): void {
    if (chunk.model) state.model = chunk.model;
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta ?? {};
      const piece = normalizeContent(delta.content);
      if (piece !== "") {
        state.text += piece;
        onDelta(piece);
      }
      for (const tc of delta.tool_calls ?? []) {
        // Tool arguments arrive FRAGMENTED across deltas — accumulate by index.
        const index = tc.index ?? 0;
        const entry = state.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
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
        id: tc.id !== "" ? tc.id : `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.name,
        arguments: tc.arguments === "" ? "{}" : tc.arguments,
      }))
      .filter((tc) => tc.name !== "");

    const promptTokens = state.usage?.prompt_tokens ?? 0;
    const completionTokens = state.usage?.completion_tokens ?? 0;
    const usage: LLMUsage = {
      promptTokens,
      completionTokens,
      totalTokens: state.usage?.total_tokens ?? promptTokens + completionTokens,
    };
    if (this.opts.priceInPerMTok !== undefined && this.opts.priceOutPerMTok !== undefined) {
      usage.costUsd =
        (promptTokens / 1_000_000) * this.opts.priceInPerMTok +
        (completionTokens / 1_000_000) * this.opts.priceOutPerMTok;
    }

    return {
      text: state.text,
      toolCalls,
      usage,
      model: state.model ?? this.opts.model,
      finishReason: state.finishReason,
      latencyMs: Date.now() - started,
    };
  }
}
