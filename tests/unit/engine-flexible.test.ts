/**
 * Zero-config runs — the promise that nothing is mandatory except the model.
 * These tests deliberately import no sandbox: chat runs work, tool failures
 * degrade gracefully, and coding requirements are validated at startup.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/engine/events.js";
import type { LLMClient, LLMResponse } from "../../src/llm/types.js";
import { runAgent } from "../../src/engine/loop.js";
import { allTools } from "../../src/tools/index.js";
import { bashTool } from "../../src/tools/bash.js";
import { codingStrategy } from "../../src/strategies/coding.js";

type Scripted = { text?: string; tools?: Array<{ name: string; arguments: string }> };

function scriptedLLM(queue: Scripted[]): LLMClient {
  const next = (): LLMResponse => {
    const item = queue.shift();
    if (!item) throw new Error("scripted LLM ran out of responses");
    return {
      text: item.text ?? "",
      toolCalls: (item.tools ?? []).map((t, i) => ({
        id: `call_${i}`,
        name: t.name,
        arguments: t.arguments,
      })),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: "scripted",
      finishReason: "stop",
      latencyMs: 1,
    };
  };
  return {
    model: "scripted",
    complete: async () => next(),
    stream: async (_req, onDelta) => {
      const r = next();
      if (r.text) onDelta(r.text);
      return r;
    },
  };
}

describe("zero-config runs", () => {
  it("runs with nothing but an LLM — chat default, no sandbox, no tools", async () => {
    const events: AgentEvent[] = [];
    const result = await runAgent(
      { task: "say hi" },
      { llm: scriptedLLM([{ text: "Hi there!" }]), onEvent: (e) => events.push(e) },
    );

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("finished");
    expect(result.summary).toBe("Hi there!");
    expect(result.steps).toBe(1);
    expect(events.some((e) => e.type === "run_finished" && e.ok)).toBe(true);
  });

  it("the chat default loops through tools and ends on the text turn", async () => {
    const llm = scriptedLLM([
      { tools: [{ name: "bash", arguments: JSON.stringify({ command: "echo hi" }) }] },
      { text: "All done." },
    ]);
    const result = await runAgent({ task: "do a thing" }, { llm, tools: [bashTool] });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("All done.");
    // No sandbox was supplied: the tool failed gracefully and the model still answered.
    const toolMessages = result.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    expect(toolMessages.some((m) => m.includes("needs a sandbox"))).toBe(true);
  });

  it("validates strategy requirements at startup: codingStrategy needs a sandbox", async () => {
    await expect(
      runAgent({ task: "x" }, { llm: scriptedLLM([]), tools: allTools, strategy: codingStrategy }),
    ).rejects.toThrow(/requires a sandbox/);
  });
});
