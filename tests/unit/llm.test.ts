/**
 * LLM client tests — mocked fetch stands in for the provider. No network.
 * The client has ONE wire path (stream: true); these tests feed it SSE
 * frames and verify aggregation, fragment assembly, and the retry policy.
 */
import { describe, expect, it } from "vitest";
import {
  LLMApiError,
  OpenAICompatibleClient,
} from "../../src/llm/openai-compatible.js";

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
        const text =
          frame === "[DONE]"
            ? "data: [DONE]\n\n"
            : `data: ${JSON.stringify(frame)}\n\n`;
        controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const TEXT_FRAMES = [
  {
    model: "deepseek/deepseek-v4.1-flash",
    choices: [{ delta: { content: "PO" }, finish_reason: null }],
  },
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
          tool_calls: [
            {
              index: 0,
              id: "call_abc",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{"city"' } }],
        },
      },
    ],
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }],
        },
      },
    ],
  },
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
    expect(r.usage).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    });
    expect(r.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(r.finishReason).toBe("stop");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.max_tokens).toBe(16);
    expect(capturedBody.tools).toBeUndefined();
  });

  it("sends a provider-neutral JSON schema as response_format", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseResponse(TEXT_FRAMES);
    };
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    };
    await make(fetchImpl).complete({
      messages: [{ role: "user", content: "verdict?" }],
      maxTokens: 16,
      responseFormat: {
        type: "json_schema",
        name: "verdict",
        schema,
      },
    });

    expect(capturedBody.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "verdict",
        schema,
        strict: true,
      },
    });
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.max_tokens).toBe(16);
    expect(capturedBody.tools).toBeUndefined();
  });

  it("sends a sampling pin and records the upstream the gateway names", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseResponse([
        {
          model: "zai-org/GLM-5.3",
          provider: "Parasail",
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        },
        "[DONE]",
      ]);
    };
    const r = await make(fetchImpl).complete({
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
      seed: 42,
    });
    expect(capturedBody.temperature).toBe(0);
    expect(capturedBody.seed).toBe(42);
    expect(r.model).toBe("zai-org/GLM-5.3");
    expect(r.provider).toBe("Parasail");
  });

  it("sends reasoning effort in OpenRouter's shape and lets a call override it", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseResponse(TEXT_FRAMES);
    };
    await make(fetchImpl, {
      baseUrl: "https://openrouter.ai/api/v1",
      reasoningEffort: "low",
    }).complete({
      messages: [{ role: "user", content: "ping" }],
      reasoningEffort: "high",
    });
    expect(capturedBody.reasoning).toEqual({ effort: "high" });
    expect(capturedBody.reasoning_effort).toBeUndefined();
  });

  it("sends reasoning_effort to a direct OpenAI-compatible endpoint", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseResponse(TEXT_FRAMES);
    };
    await make(fetchImpl, {
      baseUrl: "https://api.openai.com/v1",
      reasoningEffort: "xhigh",
    }).complete({ messages: [{ role: "user", content: "ping" }] });
    expect(capturedBody.reasoning_effort).toBe("xhigh");
    expect(capturedBody.reasoning).toBeUndefined();
  });

  it("emits deltas incrementally through stream()", async () => {
    const fetchImpl: typeof fetch = async () => sseResponse(TEXT_FRAMES);
    const deltas: string[] = [];
    const r = await make(fetchImpl).stream(
      { messages: [{ role: "user", content: "ping" }] },
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual(["PO", "NG"]);
    expect(r.text).toBe("PONG"); // aggregate matches the deltas
  });

  it("streams provider reasoning separately and preserves reported reasoning-token usage", async () => {
    const fetchImpl: typeof fetch = async () =>
      sseResponse([
        { choices: [{ delta: { reasoning: "Checking " } }] },
        { choices: [{ delta: { reasoning_content: "the context." } }] },
        { choices: [{ delta: { content: "Here is the answer." } }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 8,
            total_tokens: 18,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        },
        "[DONE]",
      ]);
    const text: string[] = [],
      reasoning: string[] = [];
    const result = await make(fetchImpl).stream(
      { messages: [{ role: "user", content: "hi" }] },
      (delta) => text.push(delta),
      { onReasoning: (delta) => reasoning.push(delta) },
    );
    expect(text).toEqual(["Here is the answer."]);
    expect(reasoning.join("")).toBe("Checking the context.");
    expect(result.reasoning).toBe("Checking the context.");
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 8,
      totalTokens: 18,
      reasoningTokens: 5,
    });
  });

  it("assembles tool calls fragmented across deltas", async () => {
    const fetchImpl: typeof fetch = async () => sseResponse(TOOL_FRAMES);
    const r = await make(fetchImpl).complete({
      messages: [{ role: "user", content: "weather?" }],
    });

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
      tools: [
        {
          type: "function",
          function: {
            name: "t",
            description: "d",
            parameters: { type: "object" },
          },
        },
      ],
    });
    expect(body.tools as unknown[]).toHaveLength(1);
  });

  it("emits prompt-cache breakpoints only when enabled", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sseResponse(TEXT_FRAMES);
    };
    await make(fetchImpl, { promptCache: { ttl: "1h" } }).complete({
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "turn scoped" },
        { role: "user", content: "request" },
      ],
      cacheBreakpoints: [0, 2],
    });
    const wire = body.messages as Array<Record<string, unknown>>;
    expect(wire[0]!.content).toEqual([
      {
        type: "text",
        text: "stable prefix",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
    expect(wire[1]!.content).toBe("turn scoped");
    expect(wire[2]!.content).toEqual([
      {
        type: "text",
        text: "request",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });

  it("defaults the cache breakpoint to the system message and is off by default", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sseResponse(TEXT_FRAMES);
    };
    await make(fetchImpl, { promptCache: true }).complete({
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "request" },
      ],
    });
    let wire = body.messages as Array<Record<string, unknown>>;
    expect(wire[0]!.content).toEqual([
      { type: "text", text: "stable prefix", cache_control: { type: "ephemeral" } },
    ]);
    expect(wire[1]!.content).toBe("request");

    await make(fetchImpl).complete({
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "request" },
      ],
      cacheBreakpoints: [0],
    });
    wire = body.messages as Array<Record<string, unknown>>;
    expect(wire[0]!.content).toBe("stable prefix");
  });

  it("serializes assistant tool_calls and tool results in wire format", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sseResponse(TEXT_FRAMES);
    };
    await make(fetchImpl).complete({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "file.txt" },
      ],
    });

    const wire = body.messages as Array<Record<string, unknown>>;
    expect(wire[2]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "bash", arguments: '{"command":"ls"}' },
        },
      ],
    });
    expect(wire[3]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "file.txt",
    });
  });

  it("computes costUsd from configured pricing", async () => {
    const fetchImpl: typeof fetch = async () => sseResponse(TEXT_FRAMES);
    const client = make(fetchImpl, { priceInPerMTok: 2, priceOutPerMTok: 6 });
    const r = await client.complete({
      messages: [{ role: "user", content: "ping" }],
    });
    // 10 tokens in * $2/M + 2 tokens out * $6/M
    expect(r.usage.costUsd).toBeCloseTo((10 / 1e6) * 2 + (2 / 1e6) * 6, 10);
  });

  it("retries on 429 and succeeds on the next attempt", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: "rate limited" }, 429)
        : sseResponse(TEXT_FRAMES);
    };
    const r = await make(fetchImpl).complete({
      messages: [{ role: "user", content: "ping" }],
    });
    expect(r.text).toBe("PONG");
    expect(calls).toBe(2);
  });

  it("throws immediately on non-retryable 4xx (no retries on a bad key)", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({ error: { message: "invalid key" } }, 401);
    };
    await expect(
      make(fetchImpl).complete({
        messages: [{ role: "user", content: "ping" }],
      }),
    ).rejects.toThrow(LLMApiError);
    expect(calls).toBe(1);
  });

  it("gives up after maxRetries on persistent 5xx", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({ error: "boom" }, 500);
    };
    await expect(
      make(fetchImpl, { maxRetries: 2 }).complete({
        messages: [{ role: "user", content: "ping" }],
      }),
    ).rejects.toThrow(/500/);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("maps prompt-cache reads and bills them at the cache-read rate", async () => {
    const frames = [
      {
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 100_000,
          total_tokens: 1_100_000,
          prompt_tokens_details: { cached_tokens: 800_000 },
        },
      },
      "[DONE]",
    ];
    const client = make(async () => sseResponse(frames), {
      priceInPerMTok: 1,
      priceOutPerMTok: 2,
      priceCacheReadPerMTok: 0.1,
    });
    const response = await client.stream({ messages: [] }, () => undefined);
    expect(response.usage.cachedTokens).toBe(800_000);
    // 0.2M uncached × $1 + 0.8M cached × $0.1 + 0.1M out × $2
    expect(response.usage.costUsd).toBeCloseTo(0.2 + 0.08 + 0.2, 6);
  });

  it("prefers provider-reported cost over the price table, and asks for it when configured", async () => {
    let capturedBody: Record<string, unknown> = {};
    const frames = [
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          cost: 0.0042,
        },
      },
      "[DONE]",
    ];
    const client = make(
      async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return sseResponse(frames);
      },
      { priceInPerMTok: 1, priceOutPerMTok: 2, includeUsageCost: true },
    );
    const response = await client.stream({ messages: [] }, () => undefined);
    expect(capturedBody.usage).toEqual({ include: true });
    expect(response.usage.costUsd).toBe(0.0042);
  });
  it("serializes user image references as OpenAI content parts", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sseResponse(TEXT_FRAMES);
    };
    await make(fetchImpl).complete({
      messages: [
        {
          role: "user",
          content: "What does this diagram show?",
          images: [
            {
              id: "img_1",
              mime: "image/png",
              url: "data:image/png;base64,AAAA",
              alt: "architecture diagram",
            },
          ],
        },
      ],
    });
    const wire = body.messages as Array<Record<string, unknown>>;
    expect(wire[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What does this diagram show?" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" },
        },
      ],
    });
  });

});
