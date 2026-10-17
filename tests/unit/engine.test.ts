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
import type { AgentEvent } from "../../src/engine/events.js";

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
