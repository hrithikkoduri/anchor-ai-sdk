/** Phases describe progress. They are not evidence gates or a second loop. */
import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import { codingPhases } from "../../src/agents/coding/phases.js";
import type { AgentStrategy } from "../../src/engine/strategy.js";
import type { AgentEvent } from "../../src/engine/events.js";
import { call, scripted } from "../helpers/scripted.js";
import { userTurn } from "../../src/engine/types.js";

const strategy: AgentStrategy = {
  name: "phased",
  phases: codingPhases,
  systemPrompt: () => "Use judgment; phases are descriptive.",
};

describe("agent-controlled approach phases", () => {
  it("can skip directly to respond and conclude without tests or force flags", async () => {
    const events: AgentEvent[] = [];
    const result = await runAgent(
      userTurn("Explain"),
      {
        llm: scripted([
          call("set_phase", {
            phase: "respond",
            reason: "enough evidence to answer",
          }),
          { text: "Here is the answer." },
        ]),
        strategy,
        onEvent: (event) => events.push(event),
      },
    );
    expect(result).toMatchObject({ ok: true, phase: "respond", steps: 2 });
    expect(
      events
        .filter((event) => event.type === "phase_started")
        .map((event) => event.type === "phase_started" && event.phase),
    ).toEqual(["understand", "respond"]);
    expect(events.some((event) => event.type === "guardrail")).toBe(false);
  });

  it("can revisit an earlier phase when new evidence changes the approach", async () => {
    const result = await runAgent(
      userTurn("Inspect"),
      {
        strategy,
        llm: scripted([
          call("set_phase", { phase: "validate" }),
          call("set_phase", {
            phase: "understand",
            reason: "the assumption was wrong",
          }),
          { text: "Revised my conclusion." },
        ]),
      },
    );
    expect(result).toMatchObject({ ok: true, phase: "understand" });
  });

  it("an invalid phase label is a tool error, not an obligation to stay in a loop", async () => {
    const result = await runAgent(
      userTurn("Inspect"),
      {
        strategy,
        llm: scripted([
          call("set_phase", { phase: "missing" }),
          { text: "Here is the answer." },
        ]),
      },
    );
    expect(result).toMatchObject({ reason: "finished", phase: "understand" });
    expect(result.evidence).toMatchObject([{ tool: "set_phase", ok: false }]);
  });

  it("phase reporting can be disabled without changing natural completion", async () => {
    const llm = scripted([{ text: "Answer." }]);
    await runAgent(
      userTurn("Explain"),
      { strategy, llm, intrinsics: { phase: false } },
    );
    expect(
      llm.seen[0]!.tools?.some((tool) => tool.function.name === "set_phase"),
    ).toBe(false);
  });

  const offRuns: Array<[string, Partial<Parameters<typeof runAgent>[1]>]> = [
    ["intrinsics.phase: false", { strategy, intrinsics: { phase: false } }],
    ["phases: []", { strategy: { ...strategy, phases: [] } }],
  ];
  for (const [label, options] of offRuns) {
    it(`with ${label} no phase reaches the model, the events, or the hand-back`, async () => {
      const store = new MemoryThreadStore();
      const events: AgentEvent[] = [];
      const llm = scripted([
        call("note", { text: "looked around" }),
        { text: "Done." },
      ]);
      const result = await runAgent(userTurn("Build it"), {
        ...options,
        llm,
        thread: { store, id: "off" },
        tools: [
          {
            definition: {
              name: "note",
              description: "note",
              parameters: { type: "object", properties: {} },
            },
            run: async () => ({ ok: true, content: "noted" }),
          },
        ],
        onEvent: (event) => events.push(event),
      } as Parameters<typeof runAgent>[1]);
      expect(result.ok).toBe(true);
      expect(llm.seen).toHaveLength(2);
      for (const request of llm.seen) {
        expect(JSON.stringify(request.messages)).not.toMatch(/Current phase/);
        expect(
          request.tools?.some((tool) => tool.function.name === "set_phase"),
        ).toBe(false);
      }
      expect(events.some((event) => event.type === "phase_started")).toBe(false);
      expect(events.find((event) => event.type === "run_started")).toMatchObject({
        phases: [],
      });
      expect(events.some((event) => "phase" in event)).toBe(false);
      expect(result.phase).toBeUndefined();
      expect((await store.load("off"))!.phase).toBeUndefined();
    });
  }

  it("a phased run still states its phase every turn and emits phase_started", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([
      call("set_phase", { phase: "act" }),
      { text: "Done." },
    ]);
    const result = await runAgent(userTurn("Build it"), {
      strategy,
      llm,
      onEvent: (event) => events.push(event),
    });
    expect(JSON.stringify(llm.seen[0]!.messages)).toContain("Current phase: understand");
    expect(JSON.stringify(llm.seen[1]!.messages)).toContain("Current phase: act");
    expect(
      events
        .filter((event) => event.type === "phase_started")
        .map((event) => event.type === "phase_started" && event.phase),
    ).toEqual(["understand", "act"]);
    expect(events.find((event) => event.type === "llm_call_started")).toMatchObject({
      phase: "understand",
    });
    expect(result.phase).toBe("act");
  });

  it("can pause at a caller-requested phase boundary and resume with real conversation", async () => {
    const store = new MemoryThreadStore();
    const first = await runAgent(
      userTurn("Inspect before editing"),
      {
        strategy,
        thread: { store, id: "t" },
        pauseAfterPhase: "understand",
        llm: scripted([call("set_phase", { phase: "act" })]),
      },
    );
    expect(first.reason).toBe("paused");
    expect((await store.load("t"))!.phase).toBe("act");
    const llm = scripted([{ text: "Reviewed, no changes needed." }]);
    const second = await runAgent(
      userTurn("Actually review only"),
      { strategy, thread: { store, id: "t" }, llm },
    );
    expect(second.phase).toBe("act");
    expect(llm.seen[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: "Actually review only",
    });
    expect((await store.load("t"))!.phase).toBeUndefined();
  });
});
