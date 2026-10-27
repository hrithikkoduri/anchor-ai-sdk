/**
 * Stage-1 supervision for long delegations. Fake LLM and fake tools only: no
 * network, no sandbox.
 *
 * Production motivation: a worker sat 30+ minutes on one tool call because its
 * wall-clock budget was only checked at turn boundaries; a silently stuck
 * worker was invisible to the supervisor; and a cancel waited up to 20s for
 * the call already in flight. These tests pin the three fixes.
 */
import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import { userTurn } from "../../src/engine/types.js";
import {
  CANCEL_GRACE,
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_STALL_AFTER_MS,
  waitWithCancelGrace,
} from "../../src/engine/supervision.js";
import { STEER_MAX_PER_CHILD } from "../../src/teams/steer.js";
import { defineTool, type Tool } from "../../src/tools/types.js";
import { scripted } from "../helpers/scripted.js";
import type { Agent } from "../../src/agents/types.js";
import type { LLMClient, LLMResponse } from "../../src/llm/types.js";
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

/** Waits until `ctx.signal` aborts, then reports that it was cut. */
const untilAborted = () =>
  new Promise<boolean>((resolve) => {
    const signal = currentSignal!;
    if (signal.aborted) return resolve(true);
    signal.addEventListener("abort", () => resolve(true), { once: true });
  });

/** The signal from the most recent tool invocation; set by `hangTool` below. */
let currentSignal: AbortSignal | undefined;

const hangTool = defineTool(
  {
    name: "hang",
    description: "hangs until the run's tool signal aborts it",
    parameters: { type: "object", properties: {} },
  },
  async (_input, ctx) => {
    currentSignal = ctx.signal;
    const aborted = await untilAborted();
    return { ok: false, content: aborted ? "aborted at the deadline" : "finished" };
  },
);

const childText = (
  llm: { seen: Array<{ messages: Array<{ content: string | null }> }> },
  turn: number,
): string =>
  llm.seen[turn]!.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");

const teamWith = (tools: Tool[], llm: unknown) => ({
  team: {
    members: {
      researcher: {
        agent: agent("researcher", tools),
        role: "worker" as const,
        llm: llm as LLMClient,
      },
    },
  },
});

describe("the child's deadline bites at every tool boundary", () => {
  it("aborts an in-flight tool and starts no call past the deadline", async () => {
    let secondStarted = false;
    const second = defineTool(
      {
        name: "second",
        description: "the next call in the same turn",
        parameters: { type: "object", properties: {} },
      },
      async () => {
        secondStarted = true;
        return { ok: true, content: "second ran" };
      },
    );
    const child = scripted([
      {
        tools: [
          { name: "hang", arguments: "{}" },
          { name: "second", arguments: "{}" },
        ],
      },
      { text: "should never run" },
    ]);
    const parent = scripted([
      delegate({
        agent: "researcher",
        task: "hang out",
        budget: { steps: 5, wallClockMs: 200 },
      }),
      { text: "leader done" },
    ]);
    const events: AgentEvent[] = [];

    const result = await runAgent(userTurn("go"), {
      llm: parent,
      agent: agent("captain"),
      ...teamWith([hangTool, second], child),
      onEvent: (event) => events.push(event),
    });

    // The leader's run is unaffected: the child handed back what it had.
    expect(result).toMatchObject({ ok: true, reason: "finished" });
    // The in-flight call saw the abort...
    expect(currentSignal?.aborted).toBe(true);
    // ...and the next call in the same turn never started.
    expect(secondStarted).toBe(false);
    // No turn after the deadline either.
    expect(child.seen).toHaveLength(1);

    const handed = events.find(
      (event) => event.type === "tool_result" && event.name === "delegate",
    ) as { ok: boolean; content: string; meta: Record<string, unknown> } | undefined;
    expect(handed).toMatchObject({
      ok: false,
      meta: { status: "budget_exhausted", partial: true },
    });
    expect(handed!.content).toContain("ran out of its budget");
  });
});

describe("worker_stalled", () => {
  it("reports a silent child once per stall window, reset by activity", async () => {
    const slow = defineTool(
      {
        name: "slow",
        description: "returns after a beat",
        parameters: { type: "object", properties: {} },
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { ok: true, content: "slow done" };
      },
    );
    const child = scripted([
      { text: "starting", tools: [{ name: "slow", arguments: "{}" }] },
      { tools: [{ name: "hang", arguments: "{}" }] },
    ]);
    const parent = scripted([
      delegate({
        agent: "researcher",
        task: "slowly",
        budget: { steps: 5, wallClockMs: 60_000 },
      }),
      { text: "done" },
    ]);
    const progress: WorkerProgress[] = [];
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const run = runAgent(userTurn("go"), {
      llm: parent,
      agent: agent("captain"),
      ...teamWith([slow, hangTool], child),
      stallAfterMs: 30,
      signal: controller.signal,
      onProgress: (item) => progress.push(item),
      onEvent: (event) => events.push(event),
    });
    const abort = setTimeout(() => controller.abort(), 400);
    await run;
    clearTimeout(abort);

    const stalled = progress.filter((item) => item.stalled);
    // 1) while `slow` runs, 2) while `hang` runs after `slow` returned.
    expect(stalled).toHaveLength(2);
    for (const record of stalled) {
      expect(record).toMatchObject({
        worker: "researcher",
        role: "worker",
        stalled: true,
      });
      expect(record.stalledForMs).toBeGreaterThanOrEqual(25);
    }

    // The signal rides a `progress` event with the worker's last activity.
    const event = events.find(
      (item): item is Extract<AgentEvent, { type: "progress" }> =>
        item.type === "progress" && item.stalled === true,
    )!;
    expect(event).toMatchObject({ worker: "researcher", lastTool: "slow" });
    expect(event.stalledForMs).toBeGreaterThanOrEqual(25);
    expect(event.lastText).toBe("starting");
  });

  it("exposes the default window", () => {
    expect(DEFAULT_STALL_AFTER_MS).toBe(10 * 60_000);
  });
});

describe("cancel grace", () => {
  it("defaults to 5 s and lets a caller's value win", async () => {
    expect(DEFAULT_CANCEL_GRACE_MS).toBe(5_000);
    const controller = new AbortController();
    // A transport that ignores the abort signal entirely: without a grace the
    // run would wait for it forever.
    const never: LLMClient = {
      model: "never",
      complete: async () => {
        throw new Error("unexpected complete");
      },
      stream: () => new Promise<LLMResponse>(() => {}),
    };
    const started = Date.now();
    const abort = setTimeout(() => controller.abort(), 10);
    const result = await runAgent(userTurn("go"), {
      llm: never,
      agent: agent("captain"),
      signal: controller.signal,
      cancelGraceMs: 25,
    });
    clearTimeout(abort);

    expect(result).toMatchObject({ ok: false, reason: "cancelled" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives up only at the grace, and lets a fast call win", async () => {
    const controller = new AbortController();
    const pending = waitWithCancelGrace(
      new Promise<number>(() => {}),
      controller.signal,
      20,
    );
    controller.abort();
    await expect(pending).resolves.toBe(CANCEL_GRACE);

    await expect(
      waitWithCancelGrace(Promise.resolve(7), new AbortController().signal, 20),
    ).resolves.toBe(7);
  });
});

describe("progress carries what the worker is doing", () => {
  it("includes lastText and lastVerb", async () => {
    const child = scripted([
      { text: "checking src/a.ts now", ...probeCall("src/a.ts") },
      { text: "finished" },
    ]);
    const parent = scripted([
      delegate({ agent: "researcher", task: "look", budget: { steps: 5 } }),
      { text: "done" },
    ]);
    const progress: WorkerProgress[] = [];
    await runAgent(userTurn("go"), {
      llm: parent,
      agent: agent("captain"),
      ...teamWith([probe], child),
      onProgress: (item) => progress.push(item),
    });

    const first = progress[0]!;
    expect(first.lastText).toBe("checking src/a.ts now");
    expect(first.lastVerb).toContain("probe");
  });
});

describe("nudge and steer share one bounded channel", () => {
  it("accepts nudges through the same cap as steer", async () => {
    const child = scripted([probeCall("src/a.ts"), { text: "done" }]);
    const parent = scripted([
      delegate({
        agent: "researcher",
        worker: "r-1",
        task: "look",
        budget: { steps: 6 },
      }),
      { text: "ack" },
    ]);
    const accepted: boolean[] = [];
    let acted = false;
    await runAgent(userTurn("look"), {
      llm: parent,
      agent: agent("captain"),
      ...teamWith([probe], child),
      onProgress: (item) => {
        if (acted) return;
        acted = true;
        accepted.push(item.steer("steer 0"));
        accepted.push(item.steer("steer 1"));
        accepted.push(item.nudge("wrap up now"));
        accepted.push(item.nudge("wrap up again"));
        accepted.push(item.nudge("one more"));
        // The sixth directive shares the steer cap and is refused.
        accepted.push(item.steer("one too many"));
      },
    });

    expect(accepted).toEqual([true, true, true, true, true, false]);
    expect(STEER_MAX_PER_CHILD).toBe(5);
    const seen = childText(child, 1);
    expect(seen).toContain("[from the leader] wrap up now");
    expect(seen).toContain("[from the leader] one more");
    expect(seen).not.toContain("one too many");
  });
});
