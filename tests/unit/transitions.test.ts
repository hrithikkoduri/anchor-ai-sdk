/**
 * Agent-requested transitions (decision #33) — the coding strategy's
 * fix → verify handoff. The agent proposes the move; the evidence disposes.
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

describe("agent-requested transitions", () => {
  let sandbox: LocalSandbox;
  beforeEach(() => {
    sandbox = new LocalSandbox({ localPath: FIXTURE }, { quiet: true });
  });
  afterEach(async () => {
    await sandbox.destroy();
  });

  const toolMessages = (messages: Array<{ role: string; content?: string | null }>) =>
    messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");

  it("fix → verify: rejected without a green full suite, accepted with one", async () => {
    await sandbox.start();
    const events: AgentEvent[] = [];
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          { tools: [{ name: "run_tests", arguments: "{}" }] }, // fails → reproduce advances
          EDIT_FIX,
          {
            tools: [
              {
                name: "request_transition",
                // No full-suite run on record yet → rejected.
                arguments: JSON.stringify({ to: "verify", reason: "looks done to me" }),
              },
            ],
          },
          { tools: [{ name: "run_tests", arguments: "{}" }] }, // full suite passes — fix stays put
          {
            tools: [
              {
                name: "request_transition",
                arguments: JSON.stringify({ to: "verify", reason: "full suite is green" }),
              },
            ],
          }, // accepted → verify
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
    // The rejection reason comes from the evidence: the reproduce run was
    // itself a full-suite run (auto-detected), and it failed.
    expect(msgs.some((c) => c.includes("request_transition rejected:") && c.includes("failed"))).toBe(true);
    expect(msgs.some((c) => c.includes('moving to phase "verify"'))).toBe(true);
  });

  it("an unknown phase target is rejected before adjudication", async () => {
    await sandbox.start();
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          {
            tools: [
              { name: "request_transition", arguments: JSON.stringify({ to: "nope", reason: "??" }) },
            ],
          },
          { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "stopped", success: false }) }] },
        ]),
        sandbox,
        agent: codingAgent,
      },
    );

    expect(result.phase).toBe("reproduce"); // never moved
    const msgs = toolMessages(result.messages);
    expect(msgs.some((c) => c.includes('"nope" is not a phase'))).toBe(true);
  });

  it("backward moves work: verify → fix is allowed with a failing run on record", async () => {
    await sandbox.start();
    const result = await runAgent(
      { task: "fix negatives" },
      {
        llm: scripted([
          { tools: [{ name: "run_tests", arguments: "{}" }] }, // fails → fix
          EDIT_FIX,
          { tools: [{ name: "run_tests", arguments: "{}" }] }, // full suite green
          {
            tools: [
              { name: "request_transition", arguments: JSON.stringify({ to: "verify", reason: "green" }) },
            ],
          },
          { tools: [{ name: "run_tests", arguments: JSON.stringify({ command: "exit 1" }) }] }, // verify finds a red run
          {
            tools: [
              { name: "request_transition", arguments: JSON.stringify({ to: "fix", reason: "the failure needs fixing" }) },
            ],
          }, // backward move accepted
          { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "back in fix", success: false }) }] },
        ]),
        sandbox,
        agent: codingAgent,
      },
    );

    expect(result.phase).toBe("fix");
    const msgs = toolMessages(result.messages);
    expect(msgs.some((c) => c.includes('moving to phase "fix"'))).toBe(true);
  });

  it("policy-free strategies trust the agent: moves are allowed and recorded", async () => {
    // No onTransitionRequest, and evidence alone can never advance phase "a" —
    // the agent must be able to move on anyway (just not claim success).
    const multi: AgentStrategy = {
      name: "multi",
      phases: [
        { id: "a", goal: "do a", advanceOn: () => false },
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
          {
            tools: [
              {
                name: "request_transition",
                arguments: JSON.stringify({ to: "b", reason: "a cannot be done here; b still can" }),
              },
            ],
          },
          { tools: [{ name: "finish", arguments: JSON.stringify({ summary: "moved on", success: false }) }] },
        ]),
        strategy: multi,
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.phase).toBe("b");
    const started = events.filter((e) => e.type === "phase_started") as Array<{ phase: string; via?: string }>;
    expect(started.map((e) => e.phase)).toEqual(["a", "b"]);
    expect(started[1]!.via).toBe("agent_request_unverified");
    const msgs = toolMessages(result.messages);
    expect(msgs.some((c) => c.includes('moving to phase "b"') && c.includes("no transition policy"))).toBe(true);
  });
});
