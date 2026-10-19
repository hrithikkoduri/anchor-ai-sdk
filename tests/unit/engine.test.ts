/** Runtime regression tests. No model/network/VM calls: real local fixture,
 * scripted decisions, observed tool results, budgets and durable memory. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import { chatAgent, chatStrategy } from "../../src/agents/chat/index.js";
import { codingAgent, codingStrategy } from "../../src/agents/coding/index.js";
import { runAgent } from "../../src/engine/loop.js";
import {
  MemoryThreadStore,
  type StoredThread,
} from "../../src/engine/thread.js";
import type { AgentEvent } from "../../src/engine/events.js";
import { scaffoldBuggyLib } from "../helpers/buggy-lib.js";
import { call, scripted } from "../helpers/scripted.js";

const edit = () =>
  call("edit_file", {
    path: "src/sum.js",
    old_string: "numbers.filter((n) => n >= 0).reduce((a, b) => a + b, 0)",
    new_string: "numbers.reduce((a, b) => a + b, 0)",
  });

describe("agent runtime", () => {
  let sandbox: LocalSandbox;
  let fixtureDir: string;
  let events: AgentEvent[];
  beforeEach(async () => {
    // The fixture is scaffolded, not read from the repo root: the package's
    // suites must run unchanged from an extracted repository.
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), "anchor-buggy-"));
    await scaffoldBuggyLib(fixtureDir);
    sandbox = new LocalSandbox({ localPath: fixtureDir }, { quiet: true });
    await sandbox.start();
    events = [];
  });
  afterEach(async () => {
    await sandbox.destroy();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("allows an appropriate reproduce/fix/validate approach without enforcing it", async () => {
    const llm = scripted([
      call("run_tests"),
      edit(),
      call("run_tests"),
      { text: "Fixed negative handling; the existing tests pass." },
    ]);
    const result = await runAgent(
      { task: "Fix negative handling" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        onEvent: (event) => events.push(event),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      reason: "finished",
      completion: "response",
      steps: 4,
    });
    expect(
      events
        .filter(
          (event) => event.type === "tool_result" && event.name === "run_tests",
        )
        .map((event) => event.type === "tool_result" && event.ok),
    ).toEqual([false, true]);
    expect(events.some((event) => event.type === "guardrail")).toBe(false);
    expect(llm.seen[0]!.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Fix negative handling",
    });
    expect(llm.seen[0]!.messages[0]!.content).toContain("test.js");
    expect(
      await readFile(path.join(sandbox.workspace, "src/sum.js"), "utf8"),
    ).not.toContain("filter");
    expect(result.checkpointRef).toMatch(/^[a-f0-9]{40}$/);
  });

  it("can finish from understand without claiming tests passed or entering every phase", async () => {
    const result = await runAgent(
      { task: "Explain the code without editing" },
      {
        llm: scripted([
          {
            text: "Here is what the code does. I made no changes or verification claim.",
          },
        ]),
        sandbox,
        agent: codingAgent,
      },
    );
    expect(result.phase).toBe("understand");
    expect(result.completion).toBe("response");
    expect(result.evidence).toEqual([]);
  });

  it("allows an optional structured finish without test gates", async () => {
    const result = await runAgent(
      { task: "Explain the code" },
      {
        llm: scripted([
          call("finish", {
            summary: "Explanation delivered; no tests were needed.",
          }),
        ]),
        sandbox,
        agent: codingAgent,
      },
    );
    expect(result).toMatchObject({
      ok: true,
      completion: "declared",
      steps: 1,
    });
  });

  it("keeps identical-call limits configurable", async () => {
    const llm = scripted([
      call("bash", { command: "echo hi" }),
      call("bash", { command: "echo hi" }),
    ]);
    const result = await runAgent(
      { task: "Inspect" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        guardrails: { repeatedToolCallLimit: 2 },
        onEvent: (event) => events.push(event),
      },
    );
    expect(result.reason).toBe("stalled");
    expect(
      events.some(
        (event) => event.type === "guardrail" && event.kind === "loop_detected",
      ),
    ).toBe(true);
  });

  it("can disable the identical-call limit while retaining the global budget", async () => {
    const llm = scripted([
      ...Array.from({ length: 4 }, () => call("bash", { command: "echo hi" })),
      { text: "Done." },
    ]);
    const result = await runAgent(
      { task: "Inspect" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        guardrails: { repeatedToolCallLimit: false },
      },
    );
    expect(result).toMatchObject({ reason: "finished", steps: 5 });
  });

  it("stops at the step budget without demanding another phase", async () => {
    const llm = scripted([
      call("bash", { command: "echo 1" }),
      call("bash", { command: "echo 2" }),
    ]);
    const result = await runAgent(
      { task: "Inspect" },
      { llm, sandbox, agent: codingAgent, budgets: { maxSteps: 2 } },
    );
    expect(result).toMatchObject({ ok: false, reason: "max_steps", steps: 2 });
  });

  it("fails fast on an incompatible tool set or missing sandbox", async () => {
    await expect(
      runAgent(
        { task: "x" },
        { llm: scripted([]), agent: codingAgent, tools: [] },
      ),
    ).rejects.toThrow("requires tools");
    await expect(
      runAgent({ task: "x" }, { llm: scripted([]), agent: codingAgent }),
    ).rejects.toThrow("requires a sandbox");
  });

  it("records the actual user request in durable conversation across turns", async () => {
    const store = new MemoryThreadStore();
    await runAgent(
      { task: "First question" },
      {
        llm: scripted([{ text: "First answer" }]),
        agent: chatAgent,
        thread: { store, id: "t" },
      },
    );
    const llm = scripted([{ text: "Review findings, without edits" }]);
    await runAgent(
      { task: "Now review only" },
      { llm, agent: chatAgent, thread: { store, id: "t" } },
    );
    const messages = llm.seen[0]!.messages;
    expect(
      messages.some(
        (message) =>
          message.role === "user" && message.content === "First question",
      ),
    ).toBe(true);
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "Now review only",
    });
    expect(
      messages.some((message) =>
        message.content?.startsWith("Begin the task."),
      ),
    ).toBe(false);
    expect((await store.load("t"))!.phase).toBeUndefined();
  });

  it("does not guess that a genuine user message starting with PHASE is orchestration", async () => {
    const store = new MemoryThreadStore();
    await store.save("t", {
      messages: [
        {
          role: "user",
          content: "PHASE: analyze — that is the literal title of my document",
        },
      ],
    });
    const llm = scripted([{ text: "Understood." }]);
    await runAgent(
      { task: "Discuss the title" },
      { llm, agent: chatAgent, thread: { store, id: "t" } },
    );
    expect(
      llm.seen[0]!.messages.some((message) =>
        message.content?.includes("literal title"),
      ),
    ).toBe(true);
  });

  it("compacts factual history while preserving the actual current request", async () => {
    const store = new MemoryThreadStore();
    await store.save("long", {
      summary: "earlier parser work",
      messages: [
        { role: "user", content: "old request" },
        { role: "assistant", content: "x".repeat(2000) },
      ],
    });
    const llm = scripted([
      call("bash", { command: "echo current" }),
      { text: "Current response." },
    ]);
    const result = await runAgent(
      { task: "Review only now" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        thread: { store, id: "long" },
        compaction: { maxEstimatedTokens: 300, keepRecentTokens: 100 },
        onEvent: (event) => events.push(event),
      },
    );
    expect(result.reason).toBe("finished");
    expect(events.some((event) => event.type === "compacted")).toBe(true);
    // The trace carries both sides of the fold: what was folded and the summary.
    const compacted = events.find((event) => event.type === "compacted") as
      | { summary?: string; folding?: string }
      | undefined;
    expect(compacted!.summary).toContain("COMPACTED: earlier observations");
    expect(compacted!.folding).toContain("old request");
    const later = llm.seen.at(-1)!;
    expect(later.messages[0]!.content).toContain("COMPACTED");
    expect(
      later.messages.some(
        (message) =>
          message.role === "user" && message.content === "Review only now",
      ),
    ).toBe(true);
    expect((await store.load("long"))!.summary).toContain("COMPACTED");
  });

  it("persists completed tool batches, and clears resume state after a response", async () => {
    class CountingStore extends MemoryThreadStore {
      saves = 0;
      override async save(id: string, state: StoredThread) {
        this.saves++;
        return super.save(id, state);
      }
    }
    const store = new CountingStore();
    const result = await runAgent(
      { task: "Inspect" },
      {
        llm: scripted([
          call("bash", { command: "echo one" }),
          call("bash", { command: "echo two" }),
          { text: "Done." },
        ]),
        sandbox,
        agent: codingAgent,
        thread: { store, id: "t" },
      },
    );
    expect(result.ok).toBe(true);
    expect(store.saves).toBe(3);
    expect((await store.load("t"))!.phase).toBeUndefined();
  });

  it("returns unknown tools and malformed arguments as observations, including trace spans", async () => {
    const llm = scripted([
      call("nope"),
      { tools: [{ name: "bash", arguments: "{bad json" }] },
      { tools: [{ name: "bash", arguments: "null" }] },
      { text: "These calls were invalid; I did not execute them." },
    ]);
    const result = await runAgent(
      { task: "Inspect" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        onEvent: (event) => events.push(event),
      },
    );
    expect(result.reason).toBe("finished");
    expect(result.evidence.filter((item) => !item.ok)).toHaveLength(3);
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(
      3,
    );
    expect(
      result.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(3);
  });

  it("handles inference errors and cancellation without inventing task completion", async () => {
    const llm = scripted([]);
    llm.stream = async () => {
      throw new Error("provider unavailable");
    };
    const failed = await runAgent(
      { task: "Inspect" },
      { llm, agent: chatAgent },
    );
    expect(failed).toMatchObject({
      ok: false,
      reason: "error",
      error: "provider unavailable",
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runAgent(
      { task: "Inspect" },
      { llm, agent: chatAgent, signal: controller.signal },
    );
    expect(cancelled).toMatchObject({ ok: false, reason: "cancelled" });
  });

  it("rejects an unknown explicitly requested initial phase", async () => {
    await expect(
      runAgent(
        { task: "Inspect" },
        {
          llm: scripted([]),
          sandbox,
          strategy: codingStrategy,
          tools: codingAgent.tools,
          startPhase: "missing",
        },
      ),
    ).rejects.toThrow("not a phase");
  });
});
