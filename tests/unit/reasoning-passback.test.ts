/**
 * Reasoning passback — the engine keeps a turn's reasoning on the assistant
 * message and the client replays it on the next request of the tool loop,
 * under the provider's field. Mocked fetch; the captured request bodies are
 * exactly what the provider would receive.
 */
import { describe, expect, it } from "vitest";
import { chatAgent } from "../../src/agents/chat/index.js";
import { runAgent } from "../../src/engine/loop.js";
import { userTurn } from "../../src/engine/types.js";
import { OpenAICompatibleClient } from "../../src/llm/openai-compatible.js";
import type { ReasoningPassback } from "../../src/llm/types.js";
import { defineTool } from "../../src/tools/types.js";

const probe = defineTool(
  {
    name: "probe",
    description: "read-only test tool",
    parameters: { type: "object", properties: {} },
  },
  async () => ({ ok: true, content: "probe result" }),
  { readOnly: true },
);

function sse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of [...frames, "[DONE]"])
        controller.enqueue(
          encoder.encode(
            `data: ${frame === "[DONE]" ? frame : JSON.stringify(frame)}\n\n`,
          ),
        );
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const toolCallFrame = {
  choices: [
    {
      delta: {
        tool_calls: [
          { index: 0, id: "call_1", function: { name: "probe", arguments: "{}" } },
        ],
      },
    },
  ],
};
const finalFrames = [
  { choices: [{ delta: { content: "Done." } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage },
];

/** First turn, DeepSeek's shape: reasoning_content, then a tool call. */
const deepseekTurn = [
  { choices: [{ delta: { reasoning_content: "Plan: " } }] },
  { choices: [{ delta: { reasoning_content: "probe first." } }] },
  toolCallFrame,
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
];
/** First turn, OpenRouter's shape: reasoning text plus fragmented details. */
const openrouterTurn = [
  {
    choices: [
      {
        delta: {
          reasoning: "Plan: ",
          reasoning_details: [
            { type: "reasoning.text", index: 0, format: "f1", text: "Plan: " },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        delta: {
          reasoning: "probe first.",
          reasoning_details: [
            { type: "reasoning.text", index: 0, text: "probe first.", signature: "sig" },
          ],
        },
      },
    ],
  },
  toolCallFrame,
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
];
const silentTurn = [
  toolCallFrame,
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
];

/** Run a two-request tool loop; return the raw request bodies. */
async function requestBodies(
  passback: ReasoningPassback | undefined,
  firstTurn: unknown[] = deepseekTurn,
): Promise<string[]> {
  const bodies: string[] = [];
  const turns = [firstTurn, finalFrames];
  const llm = new OpenAICompatibleClient({
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    model: "deepseek/deepseek-v4.1-flash",
    retryBaseDelayMs: 1,
    ...(passback !== undefined ? { reasoningPassback: passback } : {}),
    fetchImpl: async (_url, init) => {
      bodies.push(String(init?.body));
      return sse(turns.shift()!);
    },
  });
  const result = await runAgent(userTurn("probe it"), {
    llm,
    agent: chatAgent,
    tools: [probe],
  });
  expect(result.ok).toBe(true);
  expect(bodies).toHaveLength(2);
  return bodies;
}

const assistantOnWire = (body: string): Record<string, unknown> => {
  const messages = JSON.parse(body).messages as Array<Record<string, unknown>>;
  return messages.find((message) => message.role === "assistant")!;
};

const toolCallsOnWire = [
  {
    id: "call_1",
    type: "function",
    function: { name: "probe", arguments: "{}" },
  },
];

describe("reasoningPassback", () => {
  it('"deepseek" replays the turn\'s reasoning as reasoning_content', async () => {
    const [, second] = await requestBodies("deepseek");
    expect(assistantOnWire(second!)).toEqual({
      role: "assistant",
      content: "",
      tool_calls: toolCallsOnWire,
      reasoning_content: "Plan: probe first.",
    });
  });

  it('"openrouter" replays merged reasoning_details verbatim', async () => {
    const [, second] = await requestBodies("openrouter", openrouterTurn);
    expect(assistantOnWire(second!)).toEqual({
      role: "assistant",
      content: "",
      tool_calls: toolCallsOnWire,
      reasoning_details: [
        {
          type: "reasoning.text",
          index: 0,
          format: "f1",
          text: "Plan: probe first.",
          signature: "sig",
        },
      ],
    });
  });

  it('"openrouter" falls back to reasoning text when no details came back', async () => {
    const [, second] = await requestBodies("openrouter", [
      { choices: [{ delta: { reasoning: "Plan: probe first." } }] },
      ...silentTurn,
    ]);
    expect(assistantOnWire(second!)).toEqual({
      role: "assistant",
      content: "",
      tool_calls: toolCallsOnWire,
      reasoning: "Plan: probe first.",
    });
  });

  it("false sends byte-identical requests to a client without the option", async () => {
    const off = await requestBodies(false);
    // Today's client: no option, and reasoning dropped either way — so the
    // bytes match a run whose provider returned no reasoning at all.
    expect(off).toEqual(await requestBodies(undefined));
    expect(off).toEqual(await requestBodies(false, openrouterTurn));
    expect(off).toEqual(await requestBodies(false, silentTurn));
    expect(off[1]).not.toMatch(/reasoning/);
    expect(assistantOnWire(off[1]!)).toEqual({
      role: "assistant",
      content: "",
      tool_calls: toolCallsOnWire,
    });
  });

  it("does not persist or revive replayed reasoning", async () => {
    const { MemoryThreadStore } = await import("../../src/engine/thread.js");
    const store = new MemoryThreadStore();
    const turns = [deepseekTurn, finalFrames];
    const llm = new OpenAICompatibleClient({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "m",
      reasoningPassback: "deepseek",
      fetchImpl: async () => sse(turns.shift()!),
    });
    await runAgent(userTurn("probe it"), {
      llm,
      agent: chatAgent,
      tools: [probe],
      thread: { store, id: "t1" },
    });
    const saved = await store.load("t1");
    expect(saved?.messages.some((m) => m.role === "assistant")).toBe(true);
    expect(JSON.stringify(saved)).not.toMatch(/reasoning/);
  });
});
