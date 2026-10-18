/**
 * Zero-config runs — the promise that nothing is mandatory except the model.
 * These tests deliberately import no sandbox: chat runs work, tool failures
 * degrade gracefully, and coding requirements are validated at startup.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/engine/events.js";
import type { LLMClient, LLMRequest, LLMResponse } from "../../src/llm/types.js";
import { runAgent } from "../../src/engine/loop.js";
import { allTools } from "../../src/tools/index.js";
import { bashTool } from "../../src/tools/bash.js";
import { codingAgent, codingStrategy } from "../../src/agents/coding/index.js";

type Scripted = { text?: string; tools?: Array<{ name: string; arguments: string }> };

function scriptedLLM(queue: Scripted[]): LLMClient & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = [];
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
    seen,
    complete: async (req) => {
      seen.push(structuredClone(req));
      return next();
    },
    stream: async (req, onDelta) => {
      seen.push(structuredClone(req));
      const r = next();
      if (r.text) onDelta(r.text);
      return r;
    },
  };
}

describe("zero-config runs", () => {
  it("runs with nothing but an LLM — chat default, no sandbox, no consumer tools", async () => {
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

  it("an Agent preset bundles strategy + tools; explicit options override per-field", async () => {
    // The preset supplies both — startup reaches the sandbox check (tools satisfied).
    await expect(runAgent({ task: "x" }, { llm: scriptedLLM([]), agent: codingAgent })).rejects.toThrow(
      /requires a sandbox/,
    );

    // Explicit tools win over the preset's toolbox — the requiredTools check fails fast.
    await expect(
      runAgent({ task: "x" }, { llm: scriptedLLM([]), agent: codingAgent, tools: [bashTool] }),
    ).rejects.toThrow(/requires tools that were not supplied: read_file, edit_file, search, run_tests/);
  });

  it("finish is an engine intrinsic — declared in the request without being passed", async () => {
    const llm = scriptedLLM([
      { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "all done" }) }] },
    ]);
    const result = await runAgent({ task: "say hi" }, { llm });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("all done");
    expect(result.disposition).toBe("done");
    // `tools` was never supplied, yet the wire request declares finish.
    const declared = (llm.seen[0]!.tools ?? []).map((t) => t.function.name);
    expect(declared).toContain("finish");
  });

  it("intrinsics: { finish: false } removes it (and the call is rejected)", async () => {
    const llm = scriptedLLM([
      { tools: [{ name: "finish", arguments: "{}" }] },
      { text: "fallback reply" },
    ]);
    const result = await runAgent({ task: "say hi" }, { llm, intrinsics: { finish: false } });

    expect(result.summary).toBe("fallback reply");
    const declared = (llm.seen[0]!.tools ?? []).map((t) => t.function.name);
    expect(declared).not.toContain("finish");
    const toolMessages = result.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    expect(toolMessages.some((c) => c.includes("unknown tool"))).toBe(true);
  });
});
