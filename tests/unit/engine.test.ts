/**
 * Engine tests — a scripted LLM drives the real loop against a real
 * LocalSandbox running the real fixture. No network, no Heyo: the loop,
 * guardrails, phase advancement, and message protocol are what's under test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import type { LLMClient, LLMRequest, LLMResponse } from "../../src/llm/types.js";
import { LocalSandbox } from "../../src/sandbox/local.js";
import { allTools } from "../../src/tools/index.js";
import { codingStrategy } from "../../src/strategies/coding.js";
import { runAgent } from "../../src/engine/loop.js";
import { MemoryThreadStore, type StoredThread } from "../../src/engine/thread.js";
import type { AgentEvent } from "../../src/engine/events.js";
import type { AgentStrategy } from "../../src/engine/strategy.js";

const FIXTURE_PATH = fileURLToPath(new URL("../../../../fixtures/buggy-lib", import.meta.url));

/** A scripted LLM: responses come from a queue, requests are recorded. */
class ScriptedLLM implements LLMClient {
  readonly model = "scripted";
  readonly seen: LLMRequest[] = [];
  private readonly queue: LLMResponse[];

  constructor(responses: Array<{ text?: string; toolCalls?: Array<{ name: string; arguments: string; id?: string }> }>) {
    this.queue = responses.map((r, i) => ({
      text: r.text ?? "",
      toolCalls: (r.toolCalls ?? []).map((tc, j) => ({
        id: tc.id ?? `call_${i}_${j}`,
        name: tc.name,
        arguments: tc.arguments,
      })),
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
      model: "scripted",
      finishReason: "stop",
      latencyMs: 1,
    }));
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    return this.stream(req, () => undefined);
  }

  async stream(req: LLMRequest, onDelta: (delta: string) => void): Promise<LLMResponse> {
    this.seen.push(structuredClone(req));
    // Compaction calls carry a recognizable system prompt — answer them from
    // a canned response so they don't consume the scripted queue.
    const first = req.messages[0];
    if (typeof first?.content === "string" && first.content.includes("compacting an AI agent")) {
      return {
        text: "COMPACTED: earlier work summarized",
        toolCalls: [],
        usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
        model: "scripted",
        finishReason: "stop",
        latencyMs: 1,
      };
    }
    const next = this.queue.shift();
    if (!next) throw new Error("scripted LLM ran out of responses");
    if (next.text) onDelta(next.text);
    return structuredClone(next);
  }
}

describe("engine", () => {
  let rootDir: string;
  let sandbox: LocalSandbox;
  let events: AgentEvent[];

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "harness-engine-"));
    sandbox = new LocalSandbox({ localPath: FIXTURE_PATH }, { rootDir, quiet: true });
    await sandbox.start();
    events = [];
  });

  afterEach(async () => {
    await sandbox.destroy();
    await rm(rootDir, { recursive: true, force: true });
  });

  const run = (llm: ScriptedLLM, budgets?: Record<string, number>) =>
    runAgent(
      { task: "add() ignores negative numbers" },
      {
        llm,
        sandbox,
        tools: allTools,
        strategy: codingStrategy,
        budgets,
        onEvent: (e) => events.push(e),
      },
    );

  it("runs the full arc: reproduce (failing tests) → fix → verify → finish", async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ name: "run_tests", arguments: "{}" }] }, // fails → advance to fix
      {
        toolCalls: [
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
      { toolCalls: [{ name: "run_tests", arguments: "{}" }] }, // passes → advance to verify
      {
        toolCalls: [
          { name: "finish", arguments: JSON.stringify({ summary: "fixed negative handling", success: true }) },
        ],
      },
    ]);

    const result = await run(llm);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("finished");
    expect(result.steps).toBe(4);
    expect(result.summary).toBe("fixed negative handling");
    expect(result.usage).toEqual({
      promptTokens: 400,
      completionTokens: 40,
      totalTokens: 440,
      costUsd: undefined,
    });

    // Phase advancement happened on evidence, in order.
    const phases = events.filter((e) => e.type === "phase_started").map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(["reproduce", "fix", "verify"]);
    const testResults = events.filter((e) => e.type === "tool_result" && (e as { name: string }).name === "run_tests");
    expect(testResults.map((e) => (e as { ok: boolean }).ok)).toEqual([false, true]);

    // The tool protocol carried phase messages and the full tool defs.
    const userMessages = result.messages.filter((m) => m.role === "user").map((m) => m.content ?? "");
    expect(userMessages.some((m) => m.includes("PHASE: fix"))).toBe(true);
    expect(userMessages.some((m) => m.includes("PHASE: verify"))).toBe(true);
    expect(llm.seen[0]!.tools).toHaveLength(6);
    // The strategy's prepareContext wrote the repo map into the system prompt.
    expect(String(llm.seen[0]!.messages[0]!.content)).toContain("test.js");

    // The fix really landed in the workspace.
    const fixed = await readFile(path.join(sandbox.workspace, "src", "sum.js"), "utf8");
    expect(fixed).toContain("numbers.reduce((a, b) => a + b, 0)");
    expect(fixed).not.toContain("filter");
  }, 60_000);

  it("blocks an identical tool call repeated three times", async () => {
    const same = JSON.stringify({ command: "echo hi" });
    const llm = new ScriptedLLM([
      { toolCalls: [{ name: "bash", arguments: same }] },
      { toolCalls: [{ name: "bash", arguments: same }] },
      { toolCalls: [{ name: "bash", arguments: same }] }, // third → blocked
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "gave up", success: false }) }] },
    ]);

    const result = await run(llm);

    expect(result.reason).toBe("finished");
    expect(result.ok).toBe(false);
    expect(events.some((e) => e.type === "guardrail" && (e as { kind: string }).kind === "loop_detected")).toBe(true);
    const toolMessages = result.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    expect(toolMessages.some((m) => m.includes("Blocked by loop detection"))).toBe(true);
  }, 60_000);

  it("respects a custom repeated-tool-call limit", async () => {
    const same = JSON.stringify({ command: "echo hi" });
    const llm = new ScriptedLLM([
      { toolCalls: [{ name: "bash", arguments: same }] },
      { toolCalls: [{ name: "bash", arguments: same }] }, // second identical → blocked at limit 2
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "x", success: false }) }] },
    ]);

    const result = await runAgent(
      { task: "t" },
      {
        llm,
        sandbox,
        tools: allTools,
        strategy: codingStrategy,
        guardrails: { repeatedToolCallLimit: 2 },
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.reason).toBe("finished");
    expect(
      events.some((e) => e.type === "guardrail" && (e as { kind: string }).kind === "loop_detected"),
    ).toBe(true);
  }, 60_000);

  it("can disable loop detection entirely", async () => {
    const same = JSON.stringify({ command: "echo hi" });
    const responses: Array<{ toolCalls: Array<{ name: string; arguments: string }> }> = Array.from(
      { length: 4 },
      () => ({ toolCalls: [{ name: "bash", arguments: same }] }),
    );
    responses.push({ toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "x", success: false }) }] });
    const llm = new ScriptedLLM(responses);

    const result = await runAgent(
      { task: "t" },
      {
        llm,
        sandbox,
        tools: allTools,
        strategy: codingStrategy,
        guardrails: { repeatedToolCallLimit: false },
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.reason).toBe("finished");
    expect(
      events.some((e) => e.type === "guardrail" && (e as { kind: string }).kind === "loop_detected"),
    ).toBe(false);
  }, 60_000);

  it("stops at the step budget", async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ name: "bash", arguments: '{"command":"echo 1"}' }] },
      { toolCalls: [{ name: "bash", arguments: '{"command":"echo 2"}' }] },
    ]);

    const result = await run(llm, { maxSteps: 2 });

    expect(result.reason).toBe("max_steps");
    expect(result.steps).toBe(2);
    expect(result.ok).toBe(false);
    expect(events.some((e) => e.type === "guardrail" && (e as { kind: string }).kind === "budget_exceeded")).toBe(true);
  }, 60_000);

  it("does not advance reproduce when tests could not run at all", async () => {
    // An empty workspace: run_tests finds no command (ok=false, no `ran`).
    // Reproduce must stay in phase — "couldn't run" is not "failed".
    await sandbox.exec("rm -rf package.json test.js src");
    const llm = new ScriptedLLM([
      { toolCalls: [{ name: "run_tests", arguments: "{}" }] },
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "nothing to do", success: false }) }] },
    ]);

    const result = await run(llm);

    const phases = events.filter((e) => e.type === "phase_started").map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(["reproduce"]);
    expect(result.reason).toBe("finished");
  }, 60_000);

  it("refuses to start when the strategy's required tools are missing", async () => {
    const llm = new ScriptedLLM([]);
    await expect(
      runAgent(
        { task: "x" },
        {
          llm,
          sandbox,
          tools: allTools.filter((t) => t.definition.name !== "run_tests"),
          strategy: codingStrategy,
          onEvent: () => undefined,
        },
      ),
    ).rejects.toThrow(/run_tests/);
  });

  it("rejects finish(success=true) until a full-suite pass is on record", async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ name: "run_tests", arguments: "{}" }] }, // fails → fix
      // The model claims success with no evidence — the strategy rejects it.
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "trust me", success: true }) }] },
      {
        toolCalls: [
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
      { toolCalls: [{ name: "run_tests", arguments: "{}" }] }, // full suite passes → verify
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "fixed", success: true }) }] },
    ]);

    const result = await run(llm);

    expect(result.ok).toBe(true);
    expect(result.steps).toBe(5); // the rejected finish consumed a turn, the run continued
    expect(
      events.some((e) => e.type === "guardrail" && (e as { kind: string }).kind === "finish_rejected"),
    ).toBe(true);
    const toolMessages = result.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    expect(toolMessages.some((m) => m.includes("finish(success=true) rejected"))).toBe(true);
  }, 60_000);

  it("nudges once when a phase exceeds its soft step budget", async () => {
    const tiny: AgentStrategy = {
      name: "tiny",
      phases: [{ id: "solo", goal: "do the thing", maxSteps: 2 }],
      systemPrompt: () => "s",
      enterPhaseMessage: (p) => `PHASE: ${p.id}`,
    };
    const llm = new ScriptedLLM([
      { toolCalls: [{ name: "bash", arguments: '{"command":"echo 1"}' }] },
      { toolCalls: [{ name: "bash", arguments: '{"command":"echo 2"}' }] },
      { toolCalls: [{ name: "bash", arguments: '{"command":"echo 3"}' }] },
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "impossible", success: false }) }] },
    ]);

    const result = await runAgent(
      { task: "t" },
      { llm, sandbox, tools: allTools, strategy: tiny, onEvent: (e) => events.push(e) },
    );

    const nudges = result.messages.filter((m) => m.role === "user" && (m.content ?? "").includes("soft limit"));
    expect(nudges).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("finished");
  }, 60_000);

  it("remembers a conversation across runs through a ThreadStore", async () => {
    // The generic thread capability: run 2 sees run 1's conversation. This is
    // what makes chat agents (or any multi-turn use) possible on the engine.
    const store = new MemoryThreadStore();
    const thread = { store, id: "chat-1" };
    const simple: AgentStrategy = {
      name: "simple",
      phases: [{ id: "work", goal: "do work" }],
      systemPrompt: ({ task }) => `sys: ${task}`,
      enterPhaseMessage: (p) => `PHASE: ${p.id} — ${p.goal}`,
    };

    const run1 = new ScriptedLLM([
      { toolCalls: [{ name: "bash", arguments: JSON.stringify({ command: "echo hello-from-run1" }) }] },
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "did run 1", success: false }) }] },
    ]);
    await runAgent(
      { task: "first" },
      { llm: run1, sandbox, tools: allTools, strategy: simple, thread, onEvent: (e) => events.push(e) },
    );

    const run2 = new ScriptedLLM([
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "did run 2", success: false }) }] },
    ]);
    await runAgent(
      { task: "second" },
      { llm: run2, sandbox, tools: allTools, strategy: simple, thread, onEvent: (e) => events.push(e) },
    );

    const firstRequest = run2.seen[0]!;
    // Run 1's tool result is in run 2's conversation.
    expect(firstRequest.messages.some((m) => (m.content ?? "").includes("hello-from-run1"))).toBe(true);
    // And exactly ONE fresh begin-marker (stale ones were dropped on save).
    const begins = firstRequest.messages.filter(
      (m) => m.role === "user" && (m.content ?? "").startsWith("Begin the task."),
    );
    expect(begins).toHaveLength(1);
    // The store actually holds the session now.
    const stored = await store.load("chat-1");
    expect(stored!.messages.length).toBeGreaterThan(0);
  }, 60_000);

  it("passes a pre-seeded thread summary into the system prompt", async () => {
    const store = new MemoryThreadStore();
    await store.save("t-sum", { summary: "earlier: fixed the parser", messages: [] });

    let sawSummary: string | undefined;
    const simple: AgentStrategy = {
      name: "simple",
      phases: [{ id: "work", goal: "do work" }],
      systemPrompt: ({ summary }) => {
        sawSummary = summary;
        return "sys";
      },
      enterPhaseMessage: (p) => `PHASE: ${p.id}`,
    };
    const llm = new ScriptedLLM([
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "ok", success: false }) }] },
    ]);

    await runAgent(
      { task: "x" },
      { llm, sandbox, tools: allTools, strategy: simple, thread: { store, id: "t-sum" }, onEvent: () => undefined },
    );

    expect(sawSummary).toBe("earlier: fixed the parser");
  }, 60_000);

  it("compacts a long conversation and persists the running summary", async () => {
    const store = new MemoryThreadStore();
    const thread = { store, id: "long-1" };
    const simple: AgentStrategy = {
      name: "simple",
      phases: [{ id: "work", goal: "do work" }],
      systemPrompt: ({ summary }) => `sys${summary ? `|${summary}` : ""}`,
      enterPhaseMessage: (p) => `PHASE: ${p.id}`,
    };
    const big = "x".repeat(600); // ~150 estimated tokens per turn of chatter
    const llm = new ScriptedLLM([
      { text: big, toolCalls: [{ name: "bash", arguments: JSON.stringify({ command: "echo 1" }) }] },
      { text: big, toolCalls: [{ name: "bash", arguments: JSON.stringify({ command: "echo 2" }) }] },
      { text: big, toolCalls: [{ name: "bash", arguments: JSON.stringify({ command: "echo 3" }) }] },
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "done", success: false }) }] },
    ]);

    const result = await runAgent(
      { task: "t" },
      {
        llm,
        sandbox,
        tools: allTools,
        strategy: simple,
        thread,
        compaction: { maxEstimatedTokens: 400, keepRecentTokens: 100 },
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.reason).toBe("finished");
    const compacted = events.find((e) => e.type === "compacted") as { removedMessages: number } | undefined;
    expect(compacted).toBeDefined();
    expect(compacted!.removedMessages).toBeGreaterThanOrEqual(1);

    // A later request carries the folded summary in its system prompt…
    const laterRequest = llm.seen.at(-1)!;
    expect(String(laterRequest.messages[0]!.content)).toContain("COMPACTED: earlier work summarized");
    // …the conversation keeps a phase anchor after the cut…
    expect(
      laterRequest.messages.some(
        (m) => m.role === "user" && (m.content ?? "").includes("Conversation compacted"),
      ),
    ).toBe(true);
    // …and the store persisted the summary for the next run.
    const stored = await store.load("long-1");
    expect(stored!.summary).toBe("COMPACTED: earlier work summarized");
  }, 60_000);

  it("pauses after a phase boundary and resumes in the next phase", async () => {
    const store = new MemoryThreadStore();
    const thread = { store, id: "pause-1" };

    // Run 1: reproduce fails → the engine checkpoints and pauses before fix.
    const run1 = new ScriptedLLM([{ toolCalls: [{ name: "run_tests", arguments: "{}" }] }]);
    const r1 = await runAgent(
      { task: "t" },
      {
        llm: run1,
        sandbox,
        tools: allTools,
        strategy: codingStrategy,
        thread,
        pauseAfterPhase: "reproduce",
        onEvent: (e) => events.push(e),
      },
    );

    expect(r1.reason).toBe("paused");
    expect(r1.checkpointRef).toMatch(/^[0-9a-f]{40}$/);
    expect(events.some((e) => e.type === "checkpoint")).toBe(true);
    const saved = await store.load("pause-1");
    expect(saved!.phase).toBe("fix");

    // Run 2: resumes in fix, repairs, verifies, finishes.
    const run2 = new ScriptedLLM([
      {
        toolCalls: [
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
      { toolCalls: [{ name: "run_tests", arguments: "{}" }] },
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "fixed", success: true }) }] },
    ]);
    const r2 = await runAgent(
      { task: "t" },
      { llm: run2, sandbox, tools: allTools, strategy: codingStrategy, thread, onEvent: (e) => events.push(e) },
    );

    expect(r2.ok).toBe(true);
    // The resumed run started in fix and carried run 1's conversation.
    const firstRequest = run2.seen[0]!;
    expect(
      firstRequest.messages.some((m) => m.role === "user" && (m.content ?? "").includes("PHASE: fix")),
    ).toBe(true);
    expect(firstRequest.messages.some((m) => m.role === "tool")).toBe(true);
  }, 60_000);

  it("persists the thread after every completed turn", async () => {
    class CountingStore extends MemoryThreadStore {
      saves = 0;
      override async save(id: string, stored: StoredThread): Promise<void> {
        this.saves += 1;
        await super.save(id, stored);
      }
    }
    const store = new CountingStore();
    const llm = new ScriptedLLM([
      { toolCalls: [{ name: "bash", arguments: JSON.stringify({ command: "echo 1" }) }] },
      { toolCalls: [{ name: "bash", arguments: JSON.stringify({ command: "echo 2" }) }] },
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "x", success: false }) }] },
    ]);

    await runAgent(
      { task: "t" },
      {
        llm,
        sandbox,
        tools: allTools,
        strategy: codingStrategy,
        thread: { store, id: "saves-1" },
        onEvent: () => undefined,
      },
    );

    // Two tool turns + the final save — a crash loses at most one turn.
    expect(store.saves).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("clears the resume position after a completed run (follow-up starts fresh)", async () => {
    const store = new MemoryThreadStore();
    const thread = { store, id: "followup-1" };

    const run1 = new ScriptedLLM([
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "answered", success: false }) }] },
    ]);
    await runAgent(
      { task: "first request" },
      { llm: run1, sandbox, tools: allTools, strategy: codingStrategy, thread, onEvent: () => undefined },
    );

    const saved = await store.load("followup-1");
    expect(saved!.phase).toBeUndefined(); // finished work → no resume position
    expect(saved!.messages.length).toBeGreaterThan(0); // …but the memory stays

    const run2 = new ScriptedLLM([
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "second", success: false }) }] },
    ]);
    await runAgent(
      { task: "second request" },
      { llm: run2, sandbox, tools: allTools, strategy: codingStrategy, thread, onEvent: () => undefined },
    );

    // Fresh phases over the same conversation: starts at reproduce, sees run 1.
    const firstRequest = run2.seen[0]!;
    expect(
      firstRequest.messages.some((m) => m.role === "user" && (m.content ?? "").includes("PHASE: reproduce")),
    ).toBe(true);
    expect(firstRequest.messages.some((m) => m.role === "assistant")).toBe(true);
  }, 60_000);

  it("ends with reason 'cancelled' when the signal aborts", async () => {
    const controller = new AbortController();
    const llm: LLMClient = {
      model: "scripted",
      async complete() {
        throw new Error("unused");
      },
      async stream() {
        controller.abort(); // the "stop now" switch flips mid-call
        throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      },
    };

    const result = await runAgent(
      { task: "t" },
      {
        llm,
        sandbox,
        tools: allTools,
        strategy: codingStrategy,
        signal: controller.signal,
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.reason).toBe("cancelled");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cancelled");
  }, 60_000);

  it("startPhase overrides the thread's resume position", async () => {
    const store = new MemoryThreadStore();
    await store.save("sp-1", { messages: [], phase: "fix" });
    const llm = new ScriptedLLM([
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "x", success: false }) }] },
    ]);

    const result = await runAgent(
      { task: "t" },
      {
        llm,
        sandbox,
        tools: allTools,
        strategy: codingStrategy,
        thread: { store, id: "sp-1" },
        startPhase: "reproduce",
        onEvent: () => undefined,
      },
    );

    const firstRequest = llm.seen[0]!;
    expect(
      firstRequest.messages.some((m) => m.role === "user" && (m.content ?? "").includes("PHASE: reproduce")),
    ).toBe(true);
    expect(result.phase).toBe("reproduce");
  }, 60_000);

  it("rejects an unknown startPhase at startup", async () => {
    await expect(
      runAgent(
        { task: "t" },
        {
          llm: new ScriptedLLM([]),
          sandbox,
          tools: allTools,
          strategy: codingStrategy,
          startPhase: "nope",
          onEvent: () => undefined,
        },
      ),
    ).rejects.toThrow(/not a phase/);
  }, 60_000);

  it("feeds unknown tools and malformed arguments back as tool errors", async () => {
    const llm = new ScriptedLLM([
      { toolCalls: [{ name: "nope", arguments: "{}" }] },
      { toolCalls: [{ name: "bash", arguments: "{bad json" }] },
      { toolCalls: [{ name: "finish", arguments: JSON.stringify({ summary: "done", success: false }) }] },
    ]);

    const result = await run(llm);

    const toolMessages = result.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
    expect(toolMessages.some((m) => m.includes('unknown tool "nope"'))).toBe(true);
    expect(toolMessages.some((m) => m.includes("not valid JSON"))).toBe(true);
    expect(result.reason).toBe("finished");
  }, 60_000);
});
