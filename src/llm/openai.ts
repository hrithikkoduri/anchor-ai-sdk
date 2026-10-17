/**
 * OpenAI-compatible LLM client — one POST to /chat/completions.
 *
 * Deliberately raw `fetch`, no SDK: the protocol is stable, and we need our
 * own retry policy, latency measurement, and cost accounting for the trace
 * and the $ budgets. Works with OpenRouter, OpenAI, Groq, Together, local
 * llama.cpp servers — anything speaking the same shape.
 *
 * Retry policy: 429 and 5xx are retried with exponential backoff + jitter;
 * other 4xx are deterministic and throw immediately (a bad key retried three
 * times is just a slower error).
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

/** The wire shape, loosely — fields are optional and drift between providers. */
interface ChatCompletion {
  model?: string;
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  // Some providers return an array of parts (multimodal era); keep the text parts.
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: unknown })?.text === "string"
            ? ((part as { text: string }).text)
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

  async complete(req: LLMRequest, callOpts: { signal?: AbortSignal } = {}): Promise<LLMResponse> {
    const started = Date.now();

    const body: Record<string, unknown> = { model: this.opts.model, messages: req.messages };
    if (req.tools && req.tools.length > 0) body.tools = req.tools;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = (this.opts.retryBaseDelayMs ?? 1000) * 2 ** (attempt - 1) + Math.random() * 250;
        await sleep(delay);
      }
      try {
        const res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: callOpts.signal,
        });

        if (res.ok) {
          const json = (await res.json()) as ChatCompletion;
          return this.parse(json, started);
        }

        const excerpt = (await res.text()).slice(0, 400);
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) throw new LLMApiError(res.status, excerpt);
        lastError = new LLMApiError(res.status, excerpt);
      } catch (err) {
        if (err instanceof LLMApiError && err.status !== 429 && err.status < 500) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new Error("LLM request failed after retries");
  }

  private parse(json: ChatCompletion, started: number): LLMResponse {
    const choice = json.choices?.[0];
    const message = choice?.message ?? {};

    const toolCalls: LLMToolCall[] = (message.tool_calls ?? [])
      .map((tc, i) => ({
        id: tc.id ?? `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "{}",
      }))
      .filter((tc) => tc.name !== "");

    const promptTokens = json.usage?.prompt_tokens ?? 0;
    const completionTokens = json.usage?.completion_tokens ?? 0;
    const usage: LLMUsage = {
      promptTokens,
      completionTokens,
      totalTokens: json.usage?.total_tokens ?? promptTokens + completionTokens,
    };
    if (this.opts.priceInPerMTok !== undefined && this.opts.priceOutPerMTok !== undefined) {
      usage.costUsd =
        (promptTokens / 1_000_000) * this.opts.priceInPerMTok +
        (completionTokens / 1_000_000) * this.opts.priceOutPerMTok;
    }

    return {
      text: normalizeContent(message.content),
      toolCalls,
      usage,
      model: json.model ?? this.opts.model,
      finishReason: choice?.finish_reason,
      latencyMs: Date.now() - started,
    };
  }
}
