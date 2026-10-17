/**
 * Run dispositions + watch requests — finish() can declare what comes next.
 * Scripted LLM against the real fixture in a LocalSandbox; the thread store
 * proves the resume pointer survives a "watch" conclusion.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { LLMClient, LLMResponse } from "../../src/llm/types.js";
import { LocalSandbox } from "../../src/sandbox/local.js";
import { runAgent } from "../../src/engine/loop.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import type { AgentEvent } from "../../src/engine/events.js";
import { codingAgent } from "../../src/agents/coding/index.js";

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/buggy-lib", import.meta.url));

type Scripted = { text?: string; tools?: Array<{ name: string; arguments: string }> };

function scripted(queue: Scripted[]): LLMClient {
  const next = (): LLMResponse => {
    const item = queue.shift();
    if (!item) throw new Error("scripted LLM ran out of responses");
    return {
      text: item.text ?? "",
      toolCalls: (item.tools ?? []).map((t, i) => ({ id: `c${i}`, name: t.name, arguments: t.arguments })),
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

const FIX_STEPS: Scripted[] = [
  { tools: [{ name: "run_tests", arguments: "{}" }] }, // fails → fix
  {
    tools: [
      {
        name: "edit_file",
        arguments: JSON.stringify({
          path: "src/sum.js",
          old_string: "numbers.filter((n) => n >= 0).reduce((a, b) => a + b, 0)",
          new_string: "numbers.reduce((a, b) => a + b, 0)",
        }),
      },
    ],
  },
  { tools: [{ name: "run_tests", arguments: "{}" }] }, // passes → verify
];

describe("finish dispositions + watch", () => {
  let sandbox: LocalSandbox;
  beforeEach(() => {
    sandbox = new LocalSandbox({ localPath: FIXTURE }, { quiet: true });
  });
  afterEach(async () => {
    await sandbox.destroy();
  });

  it("a watch finish carries the intent and keeps the thread's resume phase", async () => {
    await sandbox.start();
    const store = new MemoryThreadStore();
    const events: AgentEvent[] = [];
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          ...FIX_STEPS,
          {
            tools: [
              {
                name: "finish",
                arguments: JSON.stringify({
                  summary: "fixed; watching CI",
                  success: true,
                  disposition: "watch",
                  watch: { checks: true, comments: true },
                  resumeAt: "fix",
                }),
              },
            ],
          },
        ]),
        sandbox,
        agent: codingAgent,
        thread: { store, id: "watch-1" },
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.disposition).toBe("watch");
    expect(result.watch).toEqual({ checks: true, comments: true });
    expect(result.resumeAt).toBe("fix");

    // The key semantic: a completed "watch" run keeps the resume pointer.
    const saved = await store.load("watch-1");
    expect(saved?.phase).toBe("fix");

    const finished = events.find((e) => e.type === "run_finished");
    expect(finished?.type === "run_finished" ? finished.disposition : undefined).toBe("watch");
  });

  it("a plain finish defaults to done and clears the resume phase", async () => {
    await sandbox.start();
    const store = new MemoryThreadStore();
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          ...FIX_STEPS,
          { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "fixed", success: true }) }] },
        ]),
        sandbox,
        agent: codingAgent,
        thread: { store, id: "watch-2" },
      },
    );

    expect(result.disposition).toBe("done");
    expect(result.watch).toBeUndefined();
    const saved = await store.load("watch-2");
    expect(saved?.phase).toBeUndefined();
  });

  it("an unknown resumeAt is rejected; the next finish is accepted", async () => {
    await sandbox.start();
    const store = new MemoryThreadStore();
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          ...FIX_STEPS,
          { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "x", success: true, resumeAt: "nope" }) }] },
          {
            tools: [
              { name: "finish", arguments: JSON.stringify({ summary: "fixed (kept in phase)", success: true }) },
            ],
          },
        ]),
        sandbox,
        agent: codingAgent,
        thread: { store, id: "watch-3" },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("fixed (kept in phase)");
    const toolMessages = result.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    expect(toolMessages.some((c) => c.includes('resumeAt "nope"'))).toBe(true);
  });
});
