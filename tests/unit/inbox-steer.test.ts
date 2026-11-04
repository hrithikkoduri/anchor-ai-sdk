import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import {
  MemoryInboxStore,
  type InboxMessage,
  type InboxStore,
} from "../../src/engine/inbox.js";
import type { AgentEvent } from "../../src/engine/events.js";
import type { EngineOptions } from "../../src/engine/types.js";
import { chatAgent } from "../../src/agents/chat/index.js";
import { defineTool } from "../../src/tools/types.js";
import type { LLMClient, LLMRequest } from "../../src/llm/types.js";
import { call, scripted, type Turn } from "../helpers/scripted.js";
import { userTurn } from "../../src/engine/types.js";

const noop = defineTool(
  {
    name: "noop",
    description: "Does nothing; keeps the turn going.",
    parameters: { type: "object", properties: {} },
  },
  async () => ({ ok: true, content: "ok" }),
);

function model(
  turns: Turn[],
  onCall?: (callNumber: number) => void | Promise<void>,
): LLMClient & { seen: LLMRequest[] } {
  const base = scripted(turns);
  let count = 0;
  return {
    ...base,
    stream: async (request, onDelta) => {
      count += 1;
      await onCall?.(count);
      return base.stream(request, onDelta);
    },
  };
}

let seq = 0;
const message = (
  text: string,
  delivery: InboxMessage["delivery"],
): InboxMessage => ({ id: `s${++seq}`, channel: "t", text, delivery });

const base: Pick<EngineOptions, "agent" | "tools" | "snapshot"> = {
  agent: chatAgent,
  tools: [noop],
  snapshot: false,
};

/** Records every settle call so the claim contract can be asserted. */
class SpyInboxStore extends MemoryInboxStore {
  completed: string[][] = [];
  released: string[][] = [];
  override async complete(ids: string[]): Promise<void> {
    this.completed.push(ids);
    return super.complete(ids);
  }
  override async release(ids: string[]): Promise<void> {
    this.released.push(ids);
    return super.release(ids);
  }
}

/** The store contract without the optional `claimSteers`. */
function withoutClaimSteers(inner: MemoryInboxStore): InboxStore {
  return {
    push: (m) => inner.push(m),
    hasPending: (c) => inner.hasPending(c),
    hasInterject: (c) => inner.hasInterject(c),
    claimAll: (c) => inner.claimAll(c),
    complete: (ids) => inner.complete(ids),
    release: (ids) => inner.release(ids),
  };
}

const texts = (request: LLMRequest): string[] =>
  request.messages.map((m) => m.content ?? "");

describe("steer delivery", () => {
  it("nudges the running run without ending it", async () => {
    const store = new SpyInboxStore();
    const events: AgentEvent[] = [];
    const llm = model(
      [call("noop"), { text: "done, quickly" }],
      async (n) => {
        if (n === 1)
          await store.push(message("[time] 2 minutes left", "steer"));
      },
    );
    const result = await runAgent(userTurn("work"), {
      ...base,
      llm,
      inbox: { store, channel: "t" },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.reason).toBe("finished");
    expect(result.runs).toHaveLength(1);
    expect(result.summary).toBe("done, quickly");
    // Call 1 predates the steer; call 2 is the next model call and sees it.
    expect(texts(llm.seen[0]!)).not.toContain("[time] 2 minutes left");
    expect(texts(llm.seen[1]!)).toContain("[time] 2 minutes left");
    expect(events.filter((e) => e.type === "inbox_steer")).toEqual([
      { type: "inbox_steer", count: 1 },
    ]);
    expect(events.some((e) => e.type === "inbox_interject")).toBe(false);
    expect(events.some((e) => e.type === "inbox_delivered")).toBe(false);
    expect(store.pendingCount("t")).toBe(0);
  });

  it("arrives as an engine user message, never a tool result", async () => {
    const store = new MemoryInboxStore();
    const llm = model([call("noop"), { text: "ok" }], async (n) => {
      if (n === 1) await store.push(message("hurry up", "steer"));
    });
    const result = await runAgent(userTurn("work"), {
      ...base,
      llm,
      inbox: { store, channel: "t" },
    });

    const steered = llm.seen[1]!.messages.filter((m) => m.content === "hurry up");
    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatchObject({ role: "user", origin: "engine" });
    expect(steered[0]!.tool_call_id).toBeUndefined();
    const inTranscript = result.messages.find((m) => m.content === "hurry up");
    expect(inTranscript).toMatchObject({ role: "user", origin: "engine" });
  });

  it("delivers several steers oldest first, in one event", async () => {
    const store = new MemoryInboxStore();
    const events: AgentEvent[] = [];
    const llm = model([call("noop"), { text: "ok" }], async (n) => {
      if (n !== 1) return;
      await store.push(message("first nudge", "steer"));
      await store.push(message("second nudge", "steer"));
    });
    await runAgent(userTurn("work"), {
      ...base,
      llm,
      inbox: { store, channel: "t" },
      onEvent: (event) => {
        events.push(event);
      },
    });
    const seen = texts(llm.seen[1]!);
    expect(seen.indexOf("first nudge")).toBeLessThan(
      seen.indexOf("second nudge"),
    );
    expect(events.filter((e) => e.type === "inbox_steer")).toEqual([
      { type: "inbox_steer", count: 2 },
    ]);
  });

  it("leaves interject behaviour unchanged: it ends the run and the chain continues", async () => {
    const store = new MemoryInboxStore();
    const llm = model([call("noop"), { text: "redirected" }], async (n) => {
      if (n === 1) await store.push(message("change course", "interject"));
    });
    const result = await runAgent(userTurn("work"), {
      ...base,
      llm,
      inbox: { store, channel: "t" },
    });
    expect(result.runs?.map((run) => run.reason)).toEqual([
      "interrupted",
      "finished",
    ]);
    expect(texts(llm.seen[1]!)).toContain("change course");
  });

  it("leaves queue untouched: it waits for the next run", async () => {
    const store = new MemoryInboxStore();
    const events: AgentEvent[] = [];
    const llm = model(
      [call("noop"), { text: "one" }, { text: "two" }],
      async (n) => {
        if (n === 1) await store.push(message("more work", "queue"));
      },
    );
    const result = await runAgent(userTurn("work"), {
      ...base,
      llm,
      inbox: { store, channel: "t" },
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result.runs?.map((run) => run.reason)).toEqual([
      "finished",
      "finished",
    ]);
    expect(texts(llm.seen[1]!)).not.toContain("more work");
    expect(texts(llm.seen[2]!)).toContain("more work");
    expect(events.some((e) => e.type === "inbox_steer")).toBe(false);
  });

  it("yields to an interject at the same boundary: the next run gets both, interjects first", async () => {
    const store = new SpyInboxStore();
    const events: AgentEvent[] = [];
    const llm = model([call("noop"), { text: "both seen" }], async (n) => {
      if (n !== 1) return;
      await store.push(message("a nudge", "steer"));
      await store.push(message("a correction", "interject"));
    });
    const result = await runAgent(userTurn("work"), {
      ...base,
      llm,
      inbox: { store, channel: "t" },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.runs?.map((run) => run.reason)).toEqual([
      "interrupted",
      "finished",
    ]);
    // The steer was never claimed in-run; it rode the next run's batch.
    expect(events.some((e) => e.type === "inbox_steer")).toBe(false);
    const task = texts(llm.seen[1]!).slice(-2);
    expect(task).toEqual(["a correction", "a nudge"]);
    expect(store.pendingCount("t")).toBe(0);
  });

  it("does not lose a steer that arrives after the last boundary", async () => {
    const store = new MemoryInboxStore();
    const events: AgentEvent[] = [];
    // Call 1 is the run's last model call: no boundary follows it.
    const llm = model([{ text: "finished" }, { text: "handled the nudge" }], async (n) => {
      if (n === 1) await store.push(message("late nudge", "steer"));
    });
    const result = await runAgent(userTurn("work"), {
      ...base,
      llm,
      inbox: { store, channel: "t" },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events.some((e) => e.type === "inbox_steer")).toBe(false);
    expect(result.runs).toHaveLength(2);
    expect(result.summary).toBe("handled the nudge");
    expect(texts(llm.seen[1]!)).toContain("late nudge");
    expect(store.pendingCount("t")).toBe(0);
  });

  it("claimAll returns a pending steer with the queued messages, oldest first", async () => {
    const store = new MemoryInboxStore();
    await store.push(message("q1", "queue"));
    await store.push(message("s1", "steer"));
    await store.push(message("i1", "interject"));
    expect(await store.hasPending("t")).toBe(true);
    expect((await store.claimAll("t")).map((m) => m.text)).toEqual([
      "i1",
      "q1",
      "s1",
    ]);
  });

  it("never lets hasInterject or claimSteers see the wrong rows", async () => {
    const store = new MemoryInboxStore();
    await store.push(message("s1", "steer"));
    await store.push(message("q1", "queue"));
    expect(await store.hasInterject("t")).toBe(false);
    expect((await store.claimSteers("t")).map((m) => m.text)).toEqual(["s1"]);
    expect(await store.claimSteers("t")).toEqual([]);
    expect(store.pendingCount("t")).toBe(1);
  });

  it("behaves as queue on a store without claimSteers", async () => {
    const inner = new MemoryInboxStore();
    const store = withoutClaimSteers(inner);
    const events: AgentEvent[] = [];
    const llm = model(
      [call("noop"), { text: "one" }, { text: "two" }],
      async (n) => {
        if (n === 1) await store.push(message("plain steer", "steer"));
      },
    );
    const result = await runAgent(userTurn("work"), {
      ...base,
      llm,
      inbox: { store, channel: "t" },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.runs?.map((run) => run.reason)).toEqual([
      "finished",
      "finished",
    ]);
    expect(texts(llm.seen[1]!)).not.toContain("plain steer");
    expect(texts(llm.seen[2]!)).toContain("plain steer");
    expect(events.some((e) => e.type === "inbox_steer")).toBe(false);
  });

  it("completes a claim exactly once and never delivers it twice", async () => {
    const store = new SpyInboxStore();
    const nudge = message("once only", "steer");
    const llm = model(
      [call("noop"), call("noop"), call("noop"), { text: "ok" }],
      async (n) => {
        if (n === 1) await store.push(nudge);
      },
    );
    const result = await runAgent(userTurn("work"), {
      ...base,
      llm,
      inbox: { store, channel: "t" },
    });

    expect(result.runs).toHaveLength(1);
    expect(store.completed).toEqual([[nudge.id]]);
    expect(store.released).toEqual([]);
    const last = texts(llm.seen[3]!);
    expect(last.filter((text) => text === "once only")).toHaveLength(1);
  });

  it("releases a claimed steer when the run dies before a model call uses it", async () => {
    const store = new SpyInboxStore();
    const llm = model([call("noop")], async (n) => {
      if (n === 1) await store.push(message("never seen", "steer"));
    });
    // One step allowed: the boundary claims the steer, then the budget ends the run.
    const result = await runAgent(userTurn("work"), {
      ...base,
      llm,
      budgets: { maxSteps: 1 },
      inbox: { store, channel: "t" },
    });

    expect(result.reason).toBe("max_steps");
    expect(store.completed).toEqual([]);
    expect(store.released).toHaveLength(1);
    expect(store.pendingCount("t")).toBe(1);
  });
});
