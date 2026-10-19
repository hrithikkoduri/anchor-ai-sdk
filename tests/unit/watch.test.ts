/**
 * Consumer-shaped handoffs — finish() declares what comes next in the
 * CONSUMER's schema, not the engine's vocabulary. The engine declares the
 * parameter from the schema and carries the object untouched; this test plays
 * the consumer: it reads its own fields and derives the thread's resume phase.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LLMClient, LLMResponse } from "../../src/llm/types.js";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import { runAgent } from "../../src/engine/loop.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import type { AgentEvent } from "../../src/engine/events.js";
import { codingAgent } from "../../src/agents/coding/index.js";
import { scaffoldBuggyLib } from "../helpers/buggy-lib.js";

type Scripted = {
  text?: string;
  tools?: Array<{ name: string; arguments: string }>;
};

function scripted(queue: Scripted[]): LLMClient {
  const next = (): LLMResponse => {
    const item = queue.shift();
    if (!item) throw new Error("scripted LLM ran out of responses");
    return {
      text: item.text ?? "",
      toolCalls: (item.tools ?? []).map((t, i) => ({
        id: `c${i}`,
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

const FIX_STEPS: Scripted[] = [
  { tools: [{ name: "run_tests", arguments: "{}" }] }, // fails → fix
  {
    tools: [
      {
        name: "edit_file",
        arguments: JSON.stringify({
          path: "src/sum.js",
          old_string:
            "numbers.filter((n) => n >= 0).reduce((a, b) => a + b, 0)",
          new_string: "numbers.reduce((a, b) => a + b, 0)",
        }),
      },
    ],
  },
  { tools: [{ name: "run_tests", arguments: "{}" }] }, // passes → verify
];

/** The test consumer's handoff shape — its own vocabulary, not the engine's. */
const consumerHandoff = {
  schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["watch", "done"] },
      resumeAt: { type: "string" },
    },
    additionalProperties: false,
  },
  description: "Optional follow-up intent for the test consumer.",
  threadPhase: (handoff: Record<string, unknown>) =>
    handoff.intent === "watch" && typeof handoff.resumeAt === "string"
      ? handoff.resumeAt
      : undefined,
};

describe("consumer-shaped handoffs", () => {
  let sandbox: LocalSandbox;
  let fixtureDir: string;
  beforeEach(async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), "anchor-buggy-"));
    await scaffoldBuggyLib(fixtureDir);
    sandbox = new LocalSandbox({ localPath: fixtureDir }, { quiet: true });
  });
  afterEach(async () => {
    await sandbox.destroy();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("carries the handoff untouched and derives the thread's resume phase", async () => {
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
                  handoff: { intent: "watch", resumeAt: "fix" },
                }),
              },
            ],
          },
        ]),
        sandbox,
        agent: codingAgent,
        thread: { store, id: "watch-1" },
        handoff: consumerHandoff,
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.handoff).toEqual({ intent: "watch", resumeAt: "fix" });

    // The key semantic: a "watch" handoff keeps the resume pointer.
    const saved = await store.load("watch-1");
    expect(saved?.phase).toBe("fix");

    const finished = events.find((e) => e.type === "run_finished");
    expect(
      finished?.type === "run_finished" ? finished.handoff : undefined,
    ).toEqual({ intent: "watch", resumeAt: "fix" });
  });

  it("a plain finish carries no handoff and leaves the phase alone", async () => {
    await sandbox.start();
    const store = new MemoryThreadStore();
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          ...FIX_STEPS,
          {
            tools: [
              {
                name: "finish",
                arguments: JSON.stringify({ summary: "fixed", success: true }),
              },
            ],
          },
        ]),
        sandbox,
        agent: codingAgent,
        thread: { store, id: "watch-2" },
        handoff: consumerHandoff,
      },
    );

    expect(result.handoff).toBeUndefined();
    const saved = await store.load("watch-2");
    expect(saved?.phase).toBeUndefined();
  });

  it("passes the object through without judging its semantics", async () => {
    await sandbox.start();
    const store = new MemoryThreadStore();
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
                  summary: "x",
                  success: true,
                  handoff: { resumeAt: "nope" },
                }),
              },
            ],
          },
        ]),
        sandbox,
        agent: codingAgent,
        thread: { store, id: "watch-3" },
        handoff: consumerHandoff,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.handoff).toEqual({ resumeAt: "nope" }); // untouched
    // The consumer's reader decides: intent !== "watch" → no resume phase.
    expect((await store.load("watch-3"))?.phase).toBeUndefined();
  });

  it("rejects a handoff when the run has no handoff schema", async () => {
    await sandbox.start();
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
                arguments: JSON.stringify({ summary: "x", handoff: { a: 1 } }),
              },
            ],
          },
          { text: "understood" },
        ]),
        sandbox,
        agent: codingAgent,
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.handoff).toBeUndefined();
    expect(result.completion).toBe("response"); // the rejected finish did not conclude
    const rejected = events.find(
      (e) => e.type === "tool_result" && e.name === "finish",
    );
    expect(rejected?.type === "tool_result" ? rejected.content : "").toContain(
      "handoff",
    );
  });
});
