import { describe, expect, it } from "vitest";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";
import { runAgent } from "../../src/engine/loop.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import { createLedger } from "../../src/ledger/index.js";
import { defineTool } from "../../src/tools/types.js";
import type { Agent } from "../../src/agents/types.js";
import { userTurn } from "../../src/engine/types.js";

function response(
  text: string,
  toolCalls: LLMResponse["toolCalls"] = [],
): LLMResponse {
  return {
    text,
    toolCalls,
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    model: "fake",
    latencyMs: 1,
  };
}

const probe = defineTool(
  {
    name: "probe",
    description: "look at the work",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  async () => ({ ok: true, content: "probe passed" }),
);

const agent: Agent = {
  name: "test",
  strategy: {
    name: "test",
    phases: [{ id: "act", goal: "do the work" }],
    systemPrompt: () => "STABLE SYSTEM",
  },
  tools: [probe],
};

describe("prompt blocks", () => {
  it("keeps the stable system prefix identical while the ledger moves", async () => {
    const seen: LLMRequest[] = [];
    let call = 0;
    const llm: LLMClient = {
      model: "fake",
      complete: async (request) => {
        seen.push(request);
        return response("done");
      },
      stream: async (request, onDelta) => {
        seen.push(request);
        call += 1;
        const result =
          call === 1
            ? response("", [
                { id: "c1", name: "probe", arguments: "{}" },
              ])
            : response("done");
        if (result.text) onDelta(result.text);
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
      userTurn("Do the work"),
      {
        llm,
        agent,
        ledger,
        thread: { store: new MemoryThreadStore(), id: "t1" },
      },
    );

    expect(seen).toHaveLength(2);
    const first = seen[0]!.messages;
    const second = seen[1]!.messages;
    expect(first[0]?.content).toContain("STABLE SYSTEM");
    expect(first[0]?.content).not.toContain("Runtime task state");
    expect(first[0]?.content).not.toContain("Ship the change");
    expect(second[0]).toEqual(first[0]);
    expect(first.at(-1)).toMatchObject({
      role: "user",
      content: "Do the work",
    });

    const firstTurn = first.findIndex((message) =>
      message.content?.includes("Runtime task state"),
    );
    const secondTurn = second.findIndex((message) =>
      message.content?.includes("Runtime task state"),
    );
    expect(firstTurn).toBeGreaterThan(0);
    expect(firstTurn).toBeLessThan(first.length - 1);
    expect(secondTurn).toBeGreaterThan(firstTurn);
    expect(first[firstTurn]?.content).toContain("Ship the change");
    expect(second[secondTurn]?.content).toContain("Ship the change");
  });
});
