/**
 * LLM client tests — mocked fetch stands in for the provider. No network.
 * The client has ONE wire path (stream: true); these tests feed it SSE
 * frames and verify aggregation, fragment assembly, and the retry policy.
 */
import { describe, expect, it } from "vitest";
import { LLMApiError, OpenAICompatibleClient } from "../../src/llm/openai.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build a Response whose body streams the given frames as SSE. */
function sseResponse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        const text = frame === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(frame)}\n\n`;
        controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const TEXT_FRAMES = [
  { model: "deepseek/deepseek-v4.1-flash", choices: [{ delta: { content: "PO" }, finish_reason: null }] },
  { choices: [{ delta: { content: "NG" }, finish_reason: null }] },
  {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  },
  "[DONE]",
];

const TOOL_FRAMES = [
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: "call_abc", function: { name: "get_weather", arguments: "" } }],
        },
        finish_reason: null,
      },
    ],
  },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }] } }] },
  {
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  },
  "[DONE]",
];

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
  it("aggregates a streamed completion with usage, and always streams on the wire", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseResponse(TEXT_FRAMES);
    };
    const r = await make(fetchImpl).complete({
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 16,
    });

    expect(r.text).toBe("PONG");
    expect(r.toolCalls).toEqual([]);
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    expect(r.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(r.finishReason).toBe("stop");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.max_tokens).toBe(16);
    expect(capturedBody.tools).toBeUndefined();
  });

  it("emits deltas incrementally through stream()", async () => {
    const fetchImpl: typeof fetch = async () => sseResponse(TEXT_FRAMES);
    const deltas: string[] = [];
    const r = await make(fetchImpl).stream({ messages: [{ role: "user", content: "ping" }] }, (d) =>
      deltas.push(d),
    );
    expect(deltas).toEqual(["PO", "NG"]);
    expect(r.text).toBe("PONG"); // aggregate matches the deltas
  });

  it("assembles tool calls fragmented across deltas", async () => {
    const fetchImpl: typeof fetch = async () => sseResponse(TOOL_FRAMES);
    const r = await make(fetchImpl).complete({ messages: [{ role: "user", content: "weather?" }] });

    expect(r.text).toBe("");
    expect(r.toolCalls).toEqual([
      { id: "call_abc", name: "get_weather", arguments: '{"city":"Paris"}' },
    ]);
    expect(r.finishReason).toBe("tool_calls");
    expect(r.usage.totalTokens).toBe(70);
  });

  it("passes tool definitions through to the provider", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sseResponse(TEXT_FRAMES);
    };
    await make(fetchImpl).complete({
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }],
    });
    expect(body.tools as unknown[]).toHaveLength(1);
  });

  it("computes costUsd from configured pricing", async () => {
    const fetchImpl: typeof fetch = async () => sseResponse(TEXT_FRAMES);
    const client = make(fetchImpl, { priceInPerMTok: 2, priceOutPerMTok: 6 });
    const r = await client.complete({ messages: [{ role: "user", content: "ping" }] });
    // 10 tokens in * $2/M + 2 tokens out * $6/M
    expect(r.usage.costUsd).toBeCloseTo((10 / 1e6) * 2 + (2 / 1e6) * 6, 10);
  });

  it("retries on 429 and succeeds on the next attempt", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ error: "rate limited" }, 429) : sseResponse(TEXT_FRAMES);
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
