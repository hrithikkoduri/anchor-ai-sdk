/**
 * Per-child budgets, the soft/hard cap, steering, and progress. Fake LLM and
 * fake tools only: no network, no sandbox.
 *
 * Production motivation: five crew workers on two vCPUs; one open-ended brief
 * spent 194 steps / 48 minutes / 458 tool calls on work a bounded worker did
 * in 47 steps. A leader's `delegate` call also blocks, so the only way to see
 * or redirect a running worker is progress + steering.
 */
import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import { userTurn } from "../../src/engine/types.js";
import {
  DEFAULT_CHILD_BUDGET_CAP,
  DEFAULT_CHILD_BUDGET_FRACTION,
  DEFAULT_CHILD_SOFT_CAP,
  BudgetTracker,
  deriveChildBudget,
} from "../../src/engine/budgets.js";
import { createSteerChannel, STEER_MAX_PER_CHILD } from "../../src/teams/steer.js";
import { defineTool, type Tool } from "../../src/tools/types.js";
import { scripted } from "../helpers/scripted.js";
import type { Agent } from "../../src/agents/types.js";
import type { AgentEvent } from "../../src/engine/events.js";
import type { WorkerProgress } from "../../src/engine/types.js";

function agent(name: string, tools: Tool[] = []): Agent {
  return {
    name,
    strategy: {
      name,
      phases: [{ id: "work", goal: "do the work" }],
      systemPrompt: () => `${name} instructions`,
    },
    tools,
  };
}

/** Read-only, and names a path so progress has a "file touched" to report. */
const probe = defineTool(
  {
    name: "probe",
    description: "read-only probe",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  },
  async (input) => ({ ok: true, content: `read ${String(input.path ?? "")}` }),
  { readOnly: true },
);

const probeCall = (file: string) => ({
  tools: [{ name: "probe", arguments: JSON.stringify({ path: file }) }],
});

const delegate = (args: Record<string, unknown>) => ({
  tools: [{ name: "delegate", arguments: JSON.stringify(args) }],
});

const childText = (
  llm: { seen: Array<{ messages: Array<{ content: string | null }> }> },
  turn: number,
): string =>
  llm.seen[turn]!.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");

describe("a child's own budget", () => {
  it("stops at the hard cap, hands back what it had, and does not fail the leader", async () => {
    const events: AgentEvent[] = [];
    const progress: WorkerProgress[] = [];
    const child = scripted([
      { text: "mapped the entry point", ...probeCall("src/a.ts") },
      probeCall("src/b.ts"),
      probeCall("src/c.ts"),
      probeCall("src/d.ts"),
      probeCall("src/e.ts"),
    ]);
    const parent = scripted([
      delegate({
        agent: "researcher",
        worker: "researcher-2",
        task: "map it",
        budget: { steps: 5 },
      }),
      { text: "crew done" },
    ]);

    const result = await runAgent(userTurn("map the codebase"), {
      llm: parent,
      agent: agent("captain"),
      team: {
        members: {
          researcher: { agent: agent("researcher", [probe]), role: "worker", llm: child },
        },
      },
      onEvent: (event) => events.push(event),
      onProgress: (item) => progress.push(item),
    });

    // The leader's run is unaffected by the worker running out.
    expect(result).toMatchObject({ ok: true, reason: "finished" });
    // The worker got exactly its 5 turns and then stopped.
    expect(child.seen).toHaveLength(5);

    const handed = events.find(
      (event) => event.type === "tool_result" && event.name === "delegate",
    ) as { ok: boolean; content: string; meta: Record<string, unknown> } | undefined;
    expect(handed).toMatchObject({
      ok: false,
      meta: { status: "budget_exhausted", partial: true, steps: 5 },
    });
    expect(handed!.content).toContain("ran out of its budget");
    expect(handed!.content).toContain("mapped the entry point");

    // It saw the wrap-up directive at its soft cap (turn 5 of 5).
    expect(childText(child, 3)).not.toContain("Wrap-up directive");
    expect(childText(child, 4)).toContain("Wrap-up directive from your leader");
    expect(
      events.some(
        (event) => event.type === "advisory" && event.kind === "child_wrap_up",
      ),
    ).toBe(true);

    // Progress is compact and attributed to the worker.
    const last = progress.at(-1)!;
    expect(last).toMatchObject({
      worker: "researcher-2",
      agent: "researcher",
      role: "worker",
      steps: 5,
      budgetUsed: 1,
      lastTool: "probe",
    });
    expect(last.filesTouched).toContain("src/a.ts");
    expect(
      events.some(
        (event) =>
          event.type === "progress" &&
          event.worker === "researcher-2" &&
          event.lastTool === "probe",
      ),
    ).toBe(true);
  });

  it("does not spend the leader's step budget; its usage rolls up", async () => {
    const child = scripted([
      probeCall("src/a.ts"),
      probeCall("src/b.ts"),
      probeCall("src/c.ts"),
      probeCall("src/d.ts"),
      probeCall("src/e.ts"),
    ]);
    const parent = scripted([
      delegate({ agent: "researcher", task: "map it", budget: { steps: 5 } }),
      probeCall("lead/a.ts"),
      { text: "done" },
    ]);
    const result = await runAgent(userTurn("map it"), {
      llm: parent,
      // The leader is capped at its OWN three turns. If the child's five
      // counted against it, this run could never finish.
      budgets: { maxSteps: 3 },
      agent: agent("captain", [probe]),
      team: {
        members: {
          researcher: { agent: agent("researcher", [probe]), role: "worker", llm: child },
        },
      },
    });
    expect(result).toMatchObject({ ok: true, reason: "finished", steps: 3 });
    // 3 leader calls (45) + 5 child calls (75) = 120: the rollup happened.
    expect(result.usage.totalTokens).toBe(120);
  });
});

describe("steering a running child", () => {
  it("delivers directives to the child's next turn and refuses after the cap", async () => {
    const child = scripted([probeCall("src/a.ts"), probeCall("src/b.ts"), { text: "done" }]);
    const parent = scripted([
      delegate({ agent: "researcher", worker: "r-1", task: "look", budget: { steps: 6 } }),
      { text: "ack" },
    ]);
    const accepted: boolean[] = [];
    let steered = false;
    await runAgent(userTurn("look"), {
      llm: parent,
      agent: agent("captain"),
      team: {
        members: {
          researcher: { agent: agent("researcher", [probe]), role: "worker", llm: child },
        },
      },
      onProgress: (item) => {
        if (steered) return;
        steered = true;
        for (let i = 0; i < STEER_MAX_PER_CHILD + 1; i++) {
          accepted.push(item.steer(`directive ${i}`));
        }
      },
    });

    expect(accepted).toEqual([true, true, true, true, true, false]);
    const seen = childText(child, 1);
    expect(seen).toContain("[from the leader] directive 0");
    expect(seen).toContain("[from the leader] directive 4");
    expect(seen).not.toContain("directive 5");
  });

  it("registers steer_worker and refuses a worker that is not running", async () => {
    const parent = scripted([
      {
        tools: [
          {
            name: "steer_worker",
            arguments: JSON.stringify({ worker: "nobody", text: "wrap up" }),
          },
        ],
      },
      { text: "done" },
    ]);
    const result = await runAgent(userTurn("go"), {
      llm: parent,
      agent: agent("captain"),
      team: {
        members: {
          researcher: { agent: agent("researcher", [probe]), role: "worker", llm: scripted([{ text: "x" }]) },
        },
      },
    });
    const names = parent.seen[0]!.tools?.map((tool) => tool.function.name) ?? [];
    expect(names).toContain("steer_worker");
    expect(
      result.messages.some((message) =>
        message.content?.includes('no worker "nobody" is running right now'),
      ),
    ).toBe(true);
  });

  it("bounds and length-caps a directive at the channel", () => {
    const channel = createSteerChannel();
    expect(channel.push("x".repeat(5_000))).toBe(true);
    expect(channel.drain()[0]!.length).toBe(500);
    for (let i = 0; i < 4; i++) expect(channel.push(`later ${i}`)).toBe(true);
    expect(channel.push("one too many")).toBe(false);
    expect(channel.push("   ")).toBe(false);
    // A finished child refuses everything, so a late handle is honest.
    channel.close();
    expect(channel.closed).toBe(true);
    expect(channel.push("after the child ended")).toBe(false);
  });
});

describe("the soft cap is exactly 80%", () => {
  it("triggers the moment a child crosses 80% of its steps, not before", () => {
    const events: AgentEvent[] = [];
    const child = scripted([
      probeCall("s/0"),
      probeCall("s/1"),
      probeCall("s/2"),
      probeCall("s/3"),
      probeCall("s/4"),
      probeCall("s/5"),
      probeCall("s/6"),
      probeCall("s/7"),
      probeCall("s/8"),
      probeCall("s/9"),
    ]);
    const parent = scripted([
      delegate({ agent: "researcher", task: "map it", budget: { steps: 10 } }),
      { text: "done" },
    ]);
    return runAgent(userTurn("map it"), {
      llm: parent,
      agent: agent("captain"),
      team: {
        members: {
          researcher: { agent: agent("researcher", [probe]), role: "worker", llm: child },
        },
      },
      onEvent: (event) => events.push(event),
    }).then(() => {
      // 80% of 10 is 8: the directive rides the turn taken at 8/10, not 7/10.
      expect(childText(child, 7)).not.toContain("Wrap-up directive");
      expect(childText(child, 8)).toContain("Wrap-up directive");
      const advisory = events.find(
        (event) => event.type === "advisory" && event.kind === "child_wrap_up",
      ) as { detail: string } | undefined;
      expect(advisory?.detail).toContain("80%");
    });
  });

  it("is the exported constant, and usedFraction is the tightest dimension", () => {
    expect(DEFAULT_CHILD_SOFT_CAP).toBe(0.8);
    const tracker = new BudgetTracker({ maxSteps: 10 });
    expect(tracker.usedFraction(7)).toBeCloseTo(0.7);
    expect(tracker.usedFraction(8)).toBeCloseTo(0.8);
  });
});

describe("the derived-default budget policy", () => {
  it("gives at most half of the leader's remaining, capped", () => {
    const derived = deriveChildBudget(undefined, { steps: 200, usd: 10 });
    expect(DEFAULT_CHILD_BUDGET_FRACTION).toBe(0.5);
    expect(derived.steps).toBe(DEFAULT_CHILD_BUDGET_CAP.steps);
    expect(derived.usd).toBe(DEFAULT_CHILD_BUDGET_CAP.usd);
    expect(derived.wallClockMs).toBe(Math.floor(DEFAULT_CHILD_BUDGET_CAP.wallClockMs * 0.5));
  });

  it("lets an explicit budget win, even above the cap", () => {
    expect(
      deriveChildBudget(
        { steps: 500, wallClockMs: 1_000, usd: 9 },
        { steps: 10, usd: 1 },
      ),
    ).toEqual({ steps: 500, wallClockMs: 1_000, usd: 9 });
  });

  it("derives from the leader's remaining wall clock when it has one", () => {
    const derived = deriveChildBudget(undefined, {
      steps: 40,
      wallClockMs: 600_000,
      usd: 4,
    });
    expect(derived.wallClockMs).toBe(300_000);
    expect(derived.usd).toBe(1.5);
  });

  it("always leaves a child at least one turn", () => {
    const derived = deriveChildBudget(undefined, { steps: 1, usd: 0 });
    expect(derived.steps).toBe(1);
    expect(derived.usd).toBe(0);
  });
});
