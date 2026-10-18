/** Phases describe progress. They are not evidence gates or a second loop. */
import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import { codingPhases } from "../../src/agents/coding/phases.js";
import type { AgentStrategy } from "../../src/engine/strategy.js";
import type { AgentEvent } from "../../src/engine/events.js";
import { call, scripted } from "../helpers/scripted.js";

const strategy: AgentStrategy = {
  name: "phased",
  phases: codingPhases,
  systemPrompt: () => "Use judgment; phases are descriptive.",
};

describe("agent-controlled approach phases", () => {
  it("can skip directly to respond and conclude without tests or force flags", async () => {
    const events: AgentEvent[] = [];
    const result = await runAgent(
      { task: "Explain" },
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
      { task: "Inspect" },
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
      { task: "Inspect" },
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
      { task: "Explain" },
      { strategy, llm, intrinsics: { phase: false } },
    );
    expect(
      llm.seen[0]!.tools?.some((tool) => tool.function.name === "set_phase"),
    ).toBe(false);
  });

  it("can pause at a caller-requested phase boundary and resume with real conversation", async () => {
    const store = new MemoryThreadStore();
    const first = await runAgent(
      { task: "Inspect before editing" },
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
      { task: "Actually review only" },
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
