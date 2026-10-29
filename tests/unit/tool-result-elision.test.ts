import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import type { AgentEvent } from "../../src/engine/events.js";
import { estimateTokens } from "../../src/engine/compaction.js";
import { runAgent } from "../../src/engine/loop.js";
import { userTurn } from "../../src/engine/types.js";
import { chatAgent } from "../../src/agents/chat/index.js";
import { workflowAgent } from "../../src/agents/workflow/index.js";
import {
  elideToolResults,
  isElided,
  resolveToolResultElision,
  type ElideToolResultsOptions,
} from "../../src/engine/tool-elision.js";
import { invokesCheck } from "../../src/engine/workflow.js";
import { bashTool } from "../../src/tools/bash.js";
import { defineTool } from "../../src/tools/types.js";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import { scripted, type Turn } from "../helpers/scripted.js";

const SYSTEM = "You are a coding agent.";
const REQUEST = "Fix the failing test in src/math.ts.";

/** system, user, then `count` bash round trips of `chars` output each. */
function conversation(count: number, chars: number, command = (i: number) => `cat src/file-${i}.ts`): LLMMessage[] {
  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: REQUEST },
  ];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `call-${i}`, name: "bash", arguments: JSON.stringify({ command: command(i) }) }],
    });
    messages.push({
      role: "tool",
      tool_call_id: `call-${i}`,
      content: `exit code 0\n${String(i).padStart(4, "0")}${"x".repeat(chars - 17)}`,
    });
  }
  return messages;
}

const options = (overrides: Partial<ElideToolResultsOptions> = {}): ElideToolResultsOptions => ({
  ...resolveToolResultElision({}, 80_000),
  ...overrides,
});

const toolIndexes = (messages: LLMMessage[]) =>
  messages.flatMap((message, index) => (message.role === "tool" ? [index] : []));

describe("elideToolResults", () => {
  it("elides the oldest results first and stops once the view is under the target", () => {
    const messages = conversation(30, 4_000); // ≈ 30k tokens
    const pass = elideToolResults(messages, options({ triggerTokens: 20_000, targetTokens: 15_000 }));
    const tools = toolIndexes(messages);
    expect(pass.elided.length).toBeGreaterThan(0);
    // Oldest first, contiguous from the start.
    expect(pass.elided).toEqual(tools.slice(0, pass.elided.length));
    // It stopped at the target, well before the protected window.
    expect(pass.elided.length).toBeLessThan(tools.length - 4);
    expect(pass.tokensAfter).toBeLessThanOrEqual(15_000);
    expect(pass.tokensBefore - pass.tokensAfter).toBeGreaterThan(5_000);
    for (const index of tools.slice(pass.elided.length)) expect(pass.messages[index]).toBe(messages[index]);
  });

  it("marks what it removed: tool, status, size, and what the call was about", () => {
    const messages = conversation(10, 4_000);
    const pass = elideToolResults(messages, options({ triggerTokens: 1_000, targetTokens: 500 }));
    expect(pass.messages[3]!.content).toBe(
      "[elided: bash, exit 0, 4.0k chars] cat src/file-0.ts — older result removed to save context; re-run the call to see it.",
    );
    expect(isElided(pass.messages[3]!)).toBe(true);
  });

  it("never touches the system prompt, the request, assistant turns, the current turn, or the last N results", () => {
    const messages = conversation(12, 4_000);
    // The current turn: one assistant message with two calls.
    messages.push(
      {
        role: "assistant",
        content: "checking both",
        tool_calls: [
          { id: "now-a", name: "bash", arguments: '{"command":"git diff"}' },
          { id: "now-b", name: "bash", arguments: '{"command":"git log"}' },
        ],
      },
      { role: "tool", tool_call_id: "now-a", content: "exit code 0\n" + "d".repeat(4_000) },
      { role: "tool", tool_call_id: "now-b", content: "exit code 0\n" + "l".repeat(4_000) },
    );
    // A target nothing can reach: everything eligible goes.
    const pass = elideToolResults(messages, options({ triggerTokens: 100, targetTokens: 0, keepRecent: 4 }));
    const tools = toolIndexes(messages);
    const kept = tools.slice(-4);
    for (const index of kept) expect(pass.messages[index]).toBe(messages[index]);
    expect(pass.elided).toEqual(tools.slice(0, -4));
    messages.forEach((message, index) => {
      if (message.role !== "tool") expect(pass.messages[index]).toBe(message);
    });
    // Protocol shape is unchanged: every result still answers its call.
    expect(pass.messages.map((message) => [message.role, message.tool_call_id])).toEqual(
      messages.map((message) => [message.role, message.tool_call_id]),
    );
  });

  it("keeps the latest run of the workflow check and load_skill output", () => {
    const check = "npm test";
    const messages = conversation(12, 4_000, (i) => (i === 2 || i === 5 ? check : `cat f${i}`));
    messages.push(
      { role: "assistant", content: null, tool_calls: [{ id: "skill", name: "load_skill", arguments: '{"name":"tdd"}' }] },
      { role: "tool", tool_call_id: "skill", content: "skill body ".repeat(500) },
    );
    const pass = elideToolResults(
      messages,
      options({
        triggerTokens: 100,
        targetTokens: 0,
        keepRecent: 1,
        pinLatest: (call) =>
          call.name === "bash" && typeof call.input.command === "string" && invokesCheck(call.input.command, check),
      }),
    );
    const resultFor = (id: string) => messages.findIndex((message) => message.tool_call_id === id);
    expect(pass.messages[resultFor("call-5")]).toBe(messages[resultFor("call-5")]); // latest check run
    expect(isElided(pass.messages[resultFor("call-2")]!)).toBe(true); // an older check run is not pinned
    expect(pass.messages[resultFor("skill")]).toBe(messages[resultFor("skill")]);
  });

  it("is deterministic", () => {
    const opts = options({ triggerTokens: 10_000, targetTokens: 6_000 });
    const a = elideToolResults(conversation(20, 3_000), opts);
    const b = elideToolResults(conversation(20, 3_000), opts);
    expect(a).toEqual(b);
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
  });

  it("a second pass over an elided conversation is a no-op", () => {
    for (const target of [6_000, 0]) {
      const opts = options({ triggerTokens: 10_000, targetTokens: target });
      const first = elideToolResults(conversation(20, 3_000), opts);
      expect(first.elided.length).toBeGreaterThan(0);
      const second = elideToolResults(first.messages, opts);
      expect(second.elided).toEqual([]);
      expect(second.messages).toEqual(first.messages);
    }
  });

  it("does nothing under the trigger", () => {
    const messages = conversation(5, 2_000);
    const pass = elideToolResults(messages, options());
    expect(pass.elided).toEqual([]);
    pass.messages.forEach((message, index) => expect(message).toBe(messages[index]));
  });

  it("cuts a synthetic 80k-token conversation to the default target in one pass", () => {
    const messages = conversation(64, 5_200); // 64 × 5.2k chars ≈ 83k tokens
    const before = estimateTokens(messages);
    expect(before).toBeGreaterThan(80_000);
    const opts = options();
    expect(opts).toMatchObject({ triggerTokens: 80_000, targetTokens: 40_000, keepRecent: 4 });
    const pass = elideToolResults(messages, opts);
    expect(pass.tokensBefore).toBe(before);
    expect(pass.tokensAfter).toBe(estimateTokens(pass.messages));
    expect(pass.tokensAfter).toBeLessThanOrEqual(40_000);
    expect(1 - pass.tokensAfter / before).toBeGreaterThan(0.5);
  });
});

describe("tool-result elision in the loop", () => {
  const big = (label: string) =>
    defineTool(
      { name: label, description: "big read", parameters: { type: "object", properties: { n: { type: "number" } } } },
      async (input) => ({ ok: true, content: `${label}-${String(input.n)}:` + "y".repeat(6_000) }),
      { readOnly: true },
    );
  const reads = (count: number): Turn[] =>
    Array.from({ length: count }, (_, n) => ({ tools: [{ name: "read_big", arguments: JSON.stringify({ n }) }] }));

  it("elides before falling back to LLM compaction, and keeps the transcript whole", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([...reads(10), { text: "done" }]);
    const result = await runAgent(userTurn("read a lot"), {
      llm,
      agent: chatAgent,
      tools: [big("read_big")],
      compaction: { maxEstimatedTokens: 8_000, keepRecentTokens: 2_000 },
      budgets: { maxSteps: 20 },
      onEvent: (event) => events.push(event),
    });
    expect(result.ok).toBe(true);
    // No summarisation call was ever made.
    expect(llm.seen.every((request) => !request.messages[0]?.content?.includes("compacting an AI agent"))).toBe(true);
    expect(events.filter((event) => event.type === "compacted")).toHaveLength(0);
    expect(events.some((event) => event.type === "advisory" && event.kind === "tool_results_elided")).toBe(true);
    const last = llm.seen.at(-1)!.messages;
    expect(estimateTokens(last)).toBeLessThan(8_000);
    const tools = last.filter((message) => message.role === "tool");
    expect(tools[0]!.content).toMatch(/^\[elided: read_big, 6\.0k chars\]/);
    expect(tools.slice(-4).every((message) => !isElided(message))).toBe(true);
    // The stored transcript is not the projection.
    expect(result.messages.filter((message) => message.role === "tool").every((message) => !isElided(message))).toBe(true);
  });

  it("can be turned off, leaving compaction as before", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([...reads(10), { text: "done" }]);
    await runAgent(userTurn("read a lot"), {
      llm,
      agent: chatAgent,
      tools: [big("read_big")],
      compaction: { maxEstimatedTokens: 8_000, keepRecentTokens: 2_000 },
      toolResultElision: false,
      budgets: { maxSteps: 20 },
      onEvent: (event) => events.push(event),
    });
    expect(events.some((event) => event.type === "advisory" && event.kind === "tool_results_elided")).toBe(false);
    expect(events.filter((event) => event.type === "compacted").length).toBeGreaterThan(0);
  });

  it("keeps a workflow's latest check output in view, and the gate still passes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-elision-"));
    const sandbox = new LocalSandbox({ localPath: dir }, { quiet: true });
    await sandbox.start();
    try {
      const CHECK = "test -f booted.txt && printf 'CHECK-OK %.0s' $(seq 1 400)";
      const bash = (command: string): Turn => ({ tools: [{ name: "bash", arguments: JSON.stringify({ command }) }] });
      const llm = scripted([
        bash(`touch booted.txt && ${CHECK}`),
        ...reads(8),
        { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "booted" }) }] },
      ]);
      const events: AgentEvent[] = [];
      const result = await runAgent(userTurn("Repository: acme/web"), {
        llm,
        sandbox,
        snapshot: false,
        agent: workflowAgent({
          name: "environment",
          brief: "Prove it boots.",
          tools: [bashTool, big("read_big")],
          check: { command: CHECK, description: "the boot marker exists" },
        }),
        toolResultElision: { triggerTokens: 6_000, targetTokens: 3_000, keepRecent: 2 },
        compaction: false,
        budgets: { maxSteps: 20 },
        onEvent: (event) => events.push(event),
      });
      expect(invokesCheck(`touch booted.txt && ${CHECK}`, CHECK)).toBe(true);
      expect(result.reason).toBe("finished");
      expect(result.ok).toBe(true);
      const last = llm.seen.at(-1)!.messages.filter((message) => message.role === "tool");
      const elided = last.filter(isElided);
      expect(elided.length).toBeGreaterThan(0);
      // The check run is the OLDEST result, so without the pin it would go first.
      expect(last[0]!.content).toContain("CHECK-OK");
      expect(isElided(last[0]!)).toBe(false);
    } finally {
      await sandbox.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
