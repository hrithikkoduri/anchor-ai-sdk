/**
 * advance (decision #35) — phases move when the AGENT says so; each phase's
 * optional check (`validateAdvance`) decides whether the move is allowed.
 * No check = trusted and recorded.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { LLMClient, LLMResponse } from "../../src/llm/types.js";
import { LocalSandbox } from "../../src/sandbox/local.js";
import { runAgent } from "../../src/engine/loop.js";
import { codingAgent } from "../../src/agents/coding/index.js";
import type { AgentStrategy } from "../../src/engine/strategy.js";
import type { AgentEvent } from "../../src/engine/events.js";

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

const EDIT_FIX: Scripted = {
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
};

describe("advance — agent-driven moves with per-phase checks", () => {
  let sandbox: LocalSandbox;
  beforeEach(() => {
    sandbox = new LocalSandbox({ localPath: FIXTURE }, { quiet: true });
  });
  afterEach(async () => {
    await sandbox.destroy();
  });

  const toolMessages = (messages: Array<{ role: string; content?: string | null }>) =>
    messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");

  it("checked moves: fix→verify is rejected until the full suite is green, then allowed", async () => {
    await sandbox.start();
    const events: AgentEvent[] = [];
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          { tools: [{ name: "run_tests", arguments: "{}" }] }, // fails — reproduce evidence
          { tools: [{ name: "advance", arguments: "{}" }] }, // → fix (checked: failing run)
          EDIT_FIX,
          { tools: [{ name: "advance", arguments: "{}" }] }, // fix → verify? REJECTED — no green full run yet
          { tools: [{ name: "run_tests", arguments: "{}" }] }, // full suite passes
          { tools: [{ name: "advance", arguments: "{}" }] }, // → verify (checked: green)
          { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "fixed", success: true }) }] },
        ]),
        sandbox,
        agent: codingAgent,
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.phase).toBe("verify");
    const phases = events.filter((e) => e.type === "phase_started").map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(["reproduce", "fix", "verify"]);
    expect(
      events.some((e) => e.type === "guardrail" && (e as { kind: string }).kind === "transition_rejected"),
    ).toBe(true);

    const msgs = toolMessages(result.messages);
    expect(msgs.some((c) => c.includes("advance rejected:") && c.includes("failed"))).toBe(true);
    expect(msgs.some((c) => c.includes('moving to phase "verify"'))).toBe(true);
  });

  it("an unknown target is rejected", async () => {
    await sandbox.start();
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          { tools: [{ name: "advance", arguments: JSON.stringify({ to: "nope" }) }] },
          { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "stopped", success: false }) }] },
        ]),
        sandbox,
        agent: codingAgent,
      },
    );

    expect(result.phase).toBe("reproduce"); // never moved
    expect(toolMessages(result.messages).some((c) => c.includes('"nope" is not a phase'))).toBe(true);
  });

  it("the final phase has no advance target — it points at finish", async () => {
    await sandbox.start();
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          { tools: [{ name: "run_tests", arguments: "{}" }] }, // fails
          { tools: [{ name: "advance", arguments: "{}" }] }, // → fix
          EDIT_FIX,
          { tools: [{ name: "run_tests", arguments: "{}" }] }, // green
          { tools: [{ name: "advance", arguments: "{}" }] }, // → verify
          { tools: [{ name: "advance", arguments: "{}" }] }, // REJECTED — final phase
          { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "done", success: true }) }] },
        ]),
        sandbox,
        agent: codingAgent,
      },
    );

    expect(result.phase).toBe("verify");
    expect(toolMessages(result.messages).some((c) => c.includes("is the final phase"))).toBe(true);
  });

  it("backward moves work: verify → fix with a failing run on record", async () => {
    await sandbox.start();
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          { tools: [{ name: "run_tests", arguments: "{}" }] }, // fails → evidence
          { tools: [{ name: "advance", arguments: "{}" }] }, // → fix
          EDIT_FIX,
          { tools: [{ name: "run_tests", arguments: "{}" }] }, // green
          { tools: [{ name: "advance", arguments: "{}" }] }, // → verify
          { tools: [{ name: "run_tests", arguments: JSON.stringify({ command: "exit 1" }) }] }, // verify finds a red run
          { tools: [{ name: "advance", arguments: JSON.stringify({ to: "fix", reason: "the failure needs fixing" }) }] },
          { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "back in fix", success: false }) }] },
        ]),
        sandbox,
        agent: codingAgent,
      },
    );

    expect(result.phase).toBe("fix");
    expect(toolMessages(result.messages).some((c) => c.includes('moving to phase "fix"'))).toBe(true);
  });

  it("a check can delay a move — never trap the loop: force overrides and is recorded", async () => {
    await sandbox.start();
    const events: AgentEvent[] = [];
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          { tools: [{ name: "run_tests", arguments: "{}" }] }, // fails — reproduce evidence
          { tools: [{ name: "advance", arguments: "{}" }] }, // → fix (checked)
          EDIT_FIX,
          { tools: [{ name: "advance", arguments: "{}" }] }, // fix → verify DENIED (no green full run)
          {
            tools: [
              {
                name: "advance",
                // No matter what the check says, the agent can keep moving.
                arguments: JSON.stringify({ force: true, reason: "check cannot be satisfied here" }),
              },
            ],
          },
          {
            tools: [
              { name: "finish", arguments: JSON.stringify({ summary: "moved on under force", success: false }) },
            ],
          },
        ]),
        sandbox,
        agent: codingAgent,
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.phase).toBe("verify");
    const msgs = toolMessages(result.messages);
    expect(msgs.some((c) => c.includes("advance rejected:"))).toBe(true); // the check DID run
    expect(msgs.some((c) => c.includes("force override recorded"))).toBe(true);
    expect(
      events.some((e) => e.type === "guardrail" && (e as { kind: string }).kind === "check_overridden"),
    ).toBe(true);
    const started = events.filter((e) => e.type === "phase_started") as Array<{ phase: string; via?: string }>;
    expect(started.find((e) => e.phase === "verify")!.via).toBe("advance_forced");
  });

  it("unchecked strategies trust the agent: moves are allowed and recorded", async () => {
    // No validateAdvance anywhere — the agent decides, the move is recorded.
    const multi: AgentStrategy = {
      name: "multi",
      phases: [
        { id: "a", goal: "do a" },
        { id: "b", goal: "do b" },
      ],
      systemPrompt: () => "s",
      enterPhaseMessage: (p) => `PHASE: ${p.id}`,
    };
    const events: AgentEvent[] = [];
    const result = await runAgent(
      { task: "t" },
      {
        llm: scripted([
          { tools: [{ name: "advance", arguments: JSON.stringify({ reason: "a is as done as it gets" }) }] },
          { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "moved on", success: false }) }] },
        ]),
        strategy: multi,
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.phase).toBe("b");
    const started = events.filter((e) => e.type === "phase_started") as Array<{ phase: string; via?: string }>;
    expect(started.map((e) => e.phase)).toEqual(["a", "b"]);
    expect(started[1]!.via).toBe("advance_unverified");
    expect(toolMessages(result.messages).some((c) => c.includes("no advance check"))).toBe(true);
  });
});
