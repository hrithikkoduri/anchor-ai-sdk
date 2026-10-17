/**
 * LLM client tests — a mocked fetch stands in for the provider. No network.
 * The retry policy and the wire parsing are the parts that must be exact.
 */
import { describe, expect, it } from "vitest";
import { LLMApiError, OpenAICompatibleClient } from "../../src/llm/openai.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TEXT_COMPLETION = {
  model: "deepseek/deepseek-v4.1-flash",
  choices: [{ message: { content: "PONG" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

const TOOL_COMPLETION = {
  model: "deepseek/deepseek-v4.1-flash",
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          { id: "call_abc", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
};

const make = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  new OpenAICompatibleClient({
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    model: "deepseek/deepseek-v4.1-flash",
    fetchImpl,
    retryBaseDelayMs: 1,
    ...over,
  });

describe("OpenAICompatibleClient", () => {
  it("parses a text completion with usage and latency", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(TEXT_COMPLETION);
    };
    const client = make(fetchImpl);
    const r = await client.complete({ messages: [{ role: "user", content: "ping" }], maxTokens: 16 });

    expect(r.text).toBe("PONG");
    expect(r.toolCalls).toEqual([]);
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    expect(r.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(r.finishReason).toBe("stop");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(capturedBody.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(capturedBody.max_tokens).toBe(16);
    expect(capturedBody.tools).toBeUndefined();
  });

  it("parses tool calls, preserving ids and raw argument strings", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(TOOL_COMPLETION);
    const r = await make(fetchImpl).complete({
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", description: "d", parameters: { type: "object" } },
        },
      ],
    });

    expect(r.text).toBe("");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toEqual({ id: "call_abc", name: "get_weather", arguments: '{"city":"Paris"}' });
    expect(r.finishReason).toBe("tool_calls");
  });

  it("passes tool definitions through to the provider", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(TEXT_COMPLETION);
    };
    await make(fetchImpl).complete({
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }],
    });
    expect((body.tools as unknown[])).toHaveLength(1);
  });

  it("computes costUsd from configured pricing", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(TEXT_COMPLETION);
    const client = make(fetchImpl, { priceInPerMTok: 2, priceOutPerMTok: 6 });
    const r = await client.complete({ messages: [{ role: "user", content: "ping" }] });
    // 10 tokens in * $2/M + 2 tokens out * $6/M
    expect(r.usage.costUsd).toBeCloseTo((10 / 1e6) * 2 + (2 / 1e6) * 6, 10);
  });

  it("retries on 429 and succeeds on the next attempt", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ error: "rate limited" }, 429) : jsonResponse(TEXT_COMPLETION);
    };
    const r = await make(fetchImpl).complete({ messages: [{ role: "user", content: "ping" }] });
    expect(r.text).toBe("PONG");
    expect(calls).toBe(2);
  });

  it("throws immediately on non-retryable 4xx (no retries on a bad key)", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({ error: { message: "invalid key" } }, 401);
    };
    await expect(make(fetchImpl).complete({ messages: [{ role: "user", content: "ping" }] })).rejects.toThrow(
      LLMApiError,
    );
    expect(calls).toBe(1);
  });

  it("gives up after maxRetries on persistent 5xx", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({ error: "boom" }, 500);
    };
    await expect(
      make(fetchImpl, { maxRetries: 2 }).complete({ messages: [{ role: "user", content: "ping" }] }),
    ).rejects.toThrow(/500/);
    expect(calls).toBe(3); // initial + 2 retries
  });
});
