import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import { chatAgent } from "../../src/agents/chat/index.js";
import { defineTool, type Tool } from "../../src/tools/types.js";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";
import { userTurn } from "../../src/engine/types.js";

function model(
  turns: Array<{
    text?: string;
    calls?: Array<{ name: string; args?: Record<string, unknown> }>;
  }>,
): LLMClient {
  return {
    model: "scripted",
    complete: async () => {
      throw new Error("unexpected compaction");
    },
    stream: async (request: LLMRequest) => {
      const turn = turns.shift();
      if (!turn) throw new Error("out of scripted responses");
      return {
        text: turn.text ?? "",
        toolCalls: (turn.calls ?? []).map((call, i) => ({
          id: `call-${request.messages.length}-${i}`,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        })),
        model: "scripted",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        latencyMs: 1,
      } satisfies LLMResponse;
    },
  };
}

function slowRead(name: string, counter: { inFlight: number; max: number }): Tool {
  return defineTool(
    {
      name,
      description: "read-only test tool",
      parameters: { type: "object", properties: {} },
    },
    async () => {
      counter.inFlight++;
      counter.max = Math.max(counter.max, counter.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      counter.inFlight--;
      return { ok: true, content: `${name} result` };
    },
    { readOnly: true },
  );
}

describe("parallel read-only tool calls", () => {
  it("dispatches all read-only calls from one turn concurrently", async () => {
    const counter = { inFlight: 0, max: 0 };
    const tools = [
      slowRead("read_a", counter),
      slowRead("read_b", counter),
      slowRead("read_c", counter),
    ];
    const result = await runAgent(
      userTurn("read three things"),
      {
        llm: model([
          {
            calls: [{ name: "read_a" }, { name: "read_b" }, { name: "read_c" }],
          },
          { text: "done" },
        ]),
        agent: chatAgent,
        tools,
        budgets: { maxSteps: 5 },
      },
    );
    expect(counter.max).toBe(3);
    expect(result).toMatchObject({ ok: true });
  });

  it("keeps mutations serial even when read-only tools are present", async () => {
    const counter = { inFlight: 0, max: 0 };
    const read = slowRead("read_a", counter);
    const write: Tool = defineTool(
      {
        name: "write_a",
        description: "mutating test tool",
        parameters: { type: "object", properties: {} },
      },
      async () => {
        counter.inFlight++;
        counter.max = Math.max(counter.max, counter.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 50));
        counter.inFlight--;
        return { ok: true, content: "written" };
      },
    );
    await runAgent(
      userTurn("read and write"),
      {
        llm: model([
          { calls: [{ name: "read_a" }, { name: "write_a" }] },
          { text: "done" },
        ]),
        agent: chatAgent,
        tools: [read, write],
        budgets: { maxSteps: 5 },
      },
    );
    expect(counter.max).toBe(1);
  });
});
