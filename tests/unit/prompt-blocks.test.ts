import { describe, expect, it } from "vitest";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";
import { runAgent } from "../../src/engine/loop.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import { createLedger } from "../../src/ledger/index.js";
import type { Agent } from "../../src/agents/types.js";

function response(text: string): LLMResponse {
  return {
    text,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    model: "fake",
    latencyMs: 1,
  };
}

const agent: Agent = {
  name: "test",
  strategy: {
    name: "test",
    phases: [{ id: "act", goal: "do the work" }],
    systemPrompt: () => "STABLE SYSTEM",
  },
  tools: [],
};

describe("prompt blocks", () => {
  it("keeps the stable system prefix free of the changing ledger", async () => {
    const seen: LLMRequest[] = [];
    const llm: LLMClient = {
      model: "fake",
      complete: async (request) => {
        seen.push(request);
        return response("done");
      },
      stream: async (request, onDelta) => {
        seen.push(request);
        const result = response("done");
        onDelta(result.text);
        return result;
      },
    };
    const ledger = createLedger({
      taskId: "t1",
      source: "Do the work",
      goal: "Do the work",
      requirements: [{ text: "Ship the change", required: true }],
    });

    await runAgent(
      { task: "Do the work" },
      {
        llm,
        agent,
        ledger,
        thread: { store: new MemoryThreadStore(), id: "t1" },
      },
    );

    const messages = seen[0]!.messages;
    expect(messages[0]?.content).toContain("STABLE SYSTEM");
    expect(messages[0]?.content).not.toContain("Runtime task state");
    expect(messages[0]?.content).not.toContain("Ship the change");
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: "Do the work",
    });
    const turn = messages.findIndex((message) =>
      message.content?.includes("Runtime task state"),
    );
    expect(turn).toBeGreaterThan(0);
    expect(turn).toBeLessThan(messages.length - 1);
    expect(messages[turn]?.content).toContain("Ship the change");
  });
});
