import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import { userTurn } from "../../src/engine/types.js";
import { chatAgent } from "../../src/agents/chat/index.js";
import { MAX_PARALLEL_TOOL_CALLS } from "../../src/engine/dispatch.js";
import type { AgentEvent } from "../../src/engine/events.js";
import { commandKind } from "../../src/tools/batch/commands.js";
import { bashTool } from "../../src/tools/bash.js";
import type { ExecResult, Sandbox } from "../../src/sandbox/types.js";
import { scripted, type Turn } from "../helpers/scripted.js";

interface Span {
  command: string;
  start: number;
  end: number;
}

/** A sandbox whose exec only records when each command ran. */
function recordingSandbox(
  behave: (command: string) => { ms: number; exitCode?: number; throws?: boolean },
) {
  const spans: Span[] = [];
  let clock = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const sandbox = {
    id: "fake",
    backend: "fake",
    workspace: "/workspace",
    scratch: "/scratch",
    start: async () => {},
    destroy: async () => {},
    exec: async (command: string): Promise<ExecResult> => {
      const plan = behave(command);
      const span: Span = { command, start: clock++, end: -1 };
      spans.push(span);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, plan.ms));
      inFlight--;
      span.end = clock++;
      if (plan.throws) throw new Error(`exec failed: ${command}`);
      return {
        exitCode: plan.exitCode ?? 0,
        output: `out:${command}`,
        stdout: `out:${command}`,
        stderr: "",
        timedOut: false,
        durationMs: plan.ms,
      };
    },
  } as unknown as Sandbox;
  return { sandbox, spans, maxInFlight: () => maxInFlight };
}

const bashTurn = (...commands: string[]): Turn => ({
  tools: commands.map((command) => ({
    name: "bash",
    arguments: JSON.stringify({ command }),
  })),
});

async function runTurn(sandbox: Sandbox, commands: string[]) {
  const events: AgentEvent[] = [];
  const llm = scripted([bashTurn(...commands), { text: "done" }]);
  await runAgent(userTurn("look around"), {
    llm,
    sandbox,
    agent: chatAgent,
    tools: [bashTool],
    snapshot: false,
    budgets: { maxSteps: 5 },
    onEvent: (event) => events.push(event),
  });
  const results = events.filter(
    (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
      event.type === "tool_result" && event.name === "bash",
  );
  const replayed = llm.seen[1]!.messages.filter((message) => message.role === "tool");
  return { results, replayed };
}

const spanOf = (spans: Span[], command: string): Span =>
  spans.find((span) => span.command === command)!;
const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

describe("parallel read-only bash", () => {
  it("runs two read-only bash calls in one turn concurrently", async () => {
    const fake = recordingSandbox(() => ({ ms: 30 }));
    await runTurn(fake.sandbox, ["git status", "ls -la"]);
    expect(overlaps(spanOf(fake.spans, "git status"), spanOf(fake.spans, "ls -la"))).toBe(true);
  });

  it("appends results in call order, not completion order", async () => {
    const fake = recordingSandbox((command) => ({ ms: command === "git log" ? 60 : 5 }));
    const { results, replayed } = await runTurn(fake.sandbox, ["git log", "git diff"]);
    const slow = spanOf(fake.spans, "git log");
    const fast = spanOf(fake.spans, "git diff");
    expect(overlaps(slow, fast)).toBe(true);
    expect(fast.end).toBeLessThan(slow.end);
    expect(results.map((result) => result.meta?.command)).toEqual(["git log", "git diff"]);
    expect(replayed.map((message) => message.content)).toEqual([
      expect.stringContaining("out:git log"),
      expect.stringContaining("out:git diff"),
    ]);
  });

  it("serialises a mutating call between the reads around it", async () => {
    const fake = recordingSandbox(() => ({ ms: 20 }));
    const { results } = await runTurn(fake.sandbox, [
      "ls",
      "cat README.md",
      "npm install",
      "git status",
      "wc -l src/a.ts",
    ]);
    const install = spanOf(fake.spans, "npm install");
    for (const read of ["ls", "cat README.md"]) expect(spanOf(fake.spans, read).end).toBeLessThan(install.start);
    for (const read of ["git status", "wc -l src/a.ts"]) expect(spanOf(fake.spans, read).start).toBeGreaterThan(install.end);
    // The reads on each side still overlap each other.
    expect(overlaps(spanOf(fake.spans, "ls"), spanOf(fake.spans, "cat README.md"))).toBe(true);
    expect(overlaps(spanOf(fake.spans, "git status"), spanOf(fake.spans, "wc -l src/a.ts"))).toBe(true);
    expect(results.map((result) => result.meta?.command)).toEqual([
      "ls",
      "cat README.md",
      "npm install",
      "git status",
      "wc -l src/a.ts",
    ]);
  });

  it("does not run test or typecheck commands concurrently", async () => {
    const fake = recordingSandbox(() => ({ ms: 20 }));
    await runTurn(fake.sandbox, ["npm test", "npx tsc --noEmit"]);
    expect(overlaps(spanOf(fake.spans, "npm test"), spanOf(fake.spans, "npx tsc --noEmit"))).toBe(false);
    expect(fake.maxInFlight()).toBe(1);
  });

  it("a failing call does not cancel its siblings", async () => {
    const fake = recordingSandbox((command) =>
      command === "cat missing.txt"
        ? { ms: 5, exitCode: 1 }
        : command === "stat broken"
          ? { ms: 5, throws: true }
          : { ms: 40 },
    );
    const { results } = await runTurn(fake.sandbox, ["cat missing.txt", "stat broken", "git log"]);
    expect(overlaps(spanOf(fake.spans, "cat missing.txt"), spanOf(fake.spans, "git log"))).toBe(true);
    expect(results.map((result) => result.ok)).toEqual([false, false, true]);
    expect(results[1]!.content).toContain("exec failed: stat broken");
    expect(results[2]!.content).toContain("out:git log");
  });

  it(`never runs more than MAX_PARALLEL_TOOL_CALLS (${MAX_PARALLEL_TOOL_CALLS}) at once`, async () => {
    const fake = recordingSandbox(() => ({ ms: 20 }));
    const commands = Array.from({ length: 7 }, (_, i) => `cat file-${i}.txt`);
    const { results } = await runTurn(fake.sandbox, commands);
    expect(MAX_PARALLEL_TOOL_CALLS).toBe(4);
    expect(fake.maxInFlight()).toBe(MAX_PARALLEL_TOOL_CALLS);
    expect(fake.spans).toHaveLength(7);
    expect(results.map((result) => result.meta?.command)).toEqual(commands);
  });
});

describe("commandKind", () => {
  it("separates reads, checks, and writes", () => {
    expect(commandKind("git status && ls -la | wc -l")).toBe("read");
    expect(commandKind("cd app && rg foo src")).toBe("read");
    expect(commandKind("npm test")).toBe("check");
    expect(commandKind("ls && npx tsc --noEmit")).toBe("check");
    expect(commandKind("npm install")).toBe("write");
    expect(commandKind("cat a > b")).toBe("write");
    expect(commandKind("git diff --output=patch.diff")).toBe("write");
    expect(commandKind("uniq in.txt out.txt")).toBe("write");
    expect(commandKind("tree -o tree.txt")).toBe("write");
    expect(commandKind("echo $(rm -rf x)")).toBe("write");
  });
});
