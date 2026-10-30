/**
 * Thread checkpoints — the SDK-side contract.
 *
 * Pure functions (key derivation, replay, the stale-hand-back guard, the run
 * snapshot) plus a store contract proven against an in-memory implementation:
 * that is exactly what a consumer implements against Postgres. No database, no
 * network.
 */
import { describe, expect, it } from "vitest";
import {
  eventKeyFor,
  isStaleWrite,
  restorePlan,
  restoreRun,
  snapshotRun,
  toCheckpointRef,
  toolCallEventKey,
  type AppendResult,
  type CheckpointRef,
  type CheckpointStore,
  type ThreadEvent,
} from "../../src/checkpoints.js";
import { runAgent } from "../../src/engine/loop.js";
import type { AgentEvent } from "../../src/engine/events.js";
import type { AgentStrategy } from "../../src/engine/strategy.js";
import { defineTool } from "../../src/tools/types.js";
import { MemoryOperationStore } from "../../src/engine/operations.js";
import { call, scripted } from "../helpers/scripted.js";
import { userTurn } from "../../src/engine/types.js";

// ---------------------------------------------------------------------------
// eventKeyFor
// ---------------------------------------------------------------------------

describe("eventKeyFor", () => {
  it("derives the exact key for every canonical kind", () => {
    expect(eventKeyFor("message", { clientId: "m-1" })).toBe("message:m-1");
    expect(eventKeyFor("plan", { taskId: "t1", round: 2 })).toBe("plan:t1:2");
    expect(eventKeyFor("gate", { gateId: "g1", action: "approve" })).toBe(
      "gate:g1:approve",
    );
    expect(
      eventKeyFor("step", {
        taskId: "t1",
        item: "i3",
        attempt: 1,
        outcome: "ok",
      }),
    ).toBe("step:t1:i3:1:ok");
    expect(eventKeyFor("checkpoint", { threadId: "th", seq: 7 })).toBe(
      "checkpoint:th:7",
    );
    expect(
      eventKeyFor("restore", { threadId: "th", checkpointId: "cp2", n: 1 }),
    ).toBe("restore:th:cp2:1");
    expect(
      eventKeyFor("delivery", {
        threadId: "th",
        kind: "pr",
        target: "acme/api#42",
        sha: "abc123",
      }),
    ).toBe("delivery:th:pr:acme/api#42:abc123");
    expect(
      eventKeyFor("report", { taskId: "t1", kind: "experiment", slug: "run-7" }),
    ).toBe("report:t1:experiment:run-7");
  });

  it("is deterministic — same inputs, same key, regardless of order", () => {
    const a = eventKeyFor("step", {
      taskId: "t1",
      item: "i3",
      attempt: 1,
      outcome: "ok",
    });
    const b = eventKeyFor("step", {
      outcome: "ok",
      attempt: 1,
      item: "i3",
      taskId: "t1",
    });
    expect(a).toBe(b);
  });

  it("throws on an unknown kind rather than minting an empty key", () => {
    expect(() => eventKeyFor("tool_call", { taskId: "t1" })).toThrow(
      /unknown event key kind/,
    );
  });

  it("throws when a required id part is missing or blank", () => {
    expect(() => eventKeyFor("plan", { taskId: "t1" })).toThrow(
      /requires id part "round"/,
    );
    expect(() =>
      eventKeyFor("message", { clientId: "   " }),
    ).toThrow(/requires id part "clientId"/);
    expect(() =>
      eventKeyFor("delivery", {
        threadId: "th",
        kind: "pr",
        target: "acme/api#42",
      }),
    ).toThrow(/requires id part "sha"/);
  });
});

describe("toolCallEventKey", () => {
  it("accepts only a consumer-derived, work-identity key", () => {
    expect(
      toolCallEventKey({ tool: "write_record", effectKey: "refund:order_1" }),
    ).toBe("tool:write_record:refund:order_1");
  });

  it("never falls back to a per-attempt identity (call id, ordinal, UUID)", () => {
    expect(toolCallEventKey({ tool: "write_record" })).toBeUndefined();
    expect(toolCallEventKey({ tool: "write_record", effectKey: "  " })).toBeUndefined();
    expect(toolCallEventKey({ tool: "  ", effectKey: "refund:order_1" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// restorePlan / isStaleWrite — a three-checkpoint history
// ---------------------------------------------------------------------------

/** cp1@2, cp2@4, cp3@6, then a restore to cp2 appended at seq 7. */
const HISTORY: ThreadEvent[] = [
  { seq: 1, kind: "message", eventKey: "message:m1", payload: {} },
  { seq: 2, kind: "checkpoint", eventKey: "checkpoint:t:2", payload: {} },
  {
    seq: 3,
    kind: "step_finished",
    eventKey: "step:t:i1:1:ok",
    payload: { runId: "run-a" },
  },
  { seq: 4, kind: "checkpoint", eventKey: "checkpoint:t:4", payload: {} },
  {
    seq: 5,
    kind: "step_finished",
    eventKey: "step:t:i2:1:ok",
    payload: { runId: "run-a" },
  },
  { seq: 6, kind: "checkpoint", eventKey: "checkpoint:t:6", payload: {} },
  {
    seq: 7,
    kind: "restore",
    eventKey: "restore:t:cp2:1",
    payload: { eventSeq: 4, supersedes: ["run-a"] },
  },
];

describe("restorePlan", () => {
  it("replays exactly the prefix at or before the checkpoint, in seq order", () => {
    const plan = restorePlan(HISTORY, { eventSeq: 4 });
    expect(plan.head).toBe(4);
    expect(plan.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });

  it("drops events with no stored seq — they are not replayable", () => {
    const plan = restorePlan(
      [{ kind: "message", eventKey: "message:x", payload: {} }, ...HISTORY],
      { eventSeq: 2 },
    );
    expect(plan.events.map((event) => event.seq)).toEqual([1, 2]);
  });
});

describe("isStaleWrite", () => {
  const restoreEvent = HISTORY[6]!;

  it("flags events already logged inside the abandoned window as stale", () => {
    // The third checkpoint's future (seq 5, 6) sits after the restored head (4)
    // and before the restore event (7): this is the abandoned branch.
    expect(isStaleWrite(HISTORY[4]!, restoreEvent)).toBe(true); // seq 5
    expect(isStaleWrite(HISTORY[5]!, restoreEvent)).toBe(true); // seq 6
  });

  it("does not flag the replayed prefix or the restore's own new branch", () => {
    expect(isStaleWrite(HISTORY[1]!, restoreEvent)).toBe(false); // seq 2
    expect(isStaleWrite(restoreEvent, restoreEvent)).toBe(false); // seq 7
    const newBranch: ThreadEvent = {
      seq: 8,
      kind: "step_finished",
      eventKey: "step:t:i2:2:ok",
      payload: { runId: "run-b" },
    };
    expect(isStaleWrite(newBranch, restoreEvent)).toBe(false);
  });

  it("catches a late hand-back by provenance, even with a fresh seq", () => {
    const lateFromAbandoned: ThreadEvent = {
      seq: 9,
      kind: "step_finished",
      eventKey: "step:t:i3:1:ok",
      payload: { runId: "run-a" }, // superseded by the restore
    };
    const lateFromResumed: ThreadEvent = {
      seq: 10,
      kind: "step_finished",
      eventKey: "step:t:i3:2:ok",
      payload: { runId: "run-b" },
    };
    expect(isStaleWrite(lateFromAbandoned, restoreEvent)).toBe(true);
    expect(isStaleWrite(lateFromResumed, restoreEvent)).toBe(false);
  });

  it("fails open for an event with no provenance and no window", () => {
    expect(
      isStaleWrite(
        { kind: "message", eventKey: "message:later", payload: {} },
        restoreEvent,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RunSnapshot round-trip
// ---------------------------------------------------------------------------

describe("snapshotRun / restoreRun", () => {
  it("round-trips the attempt and the checkpoint it continues", () => {
    const snapshot = snapshotRun({
      eventSeq: 4,
      runId: "run-b",
      checkpointId: "cp2",
      sandboxRef: "abc123",
      attempt: "issue-7#3",
      phase: "execute",
      reason: "paused",
    });
    expect(snapshot).toEqual({
      eventSeq: 4,
      runId: "run-b",
      checkpointId: "cp2",
      sandboxRef: "abc123",
      attempt: "issue-7#3",
      phase: "execute",
      reason: "paused",
    });

    const restored = restoreRun(snapshot, HISTORY);
    expect(restored.snapshot).toEqual(snapshot);
    expect(restored.head).toBe(4);
    expect(restored.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });

  it("rejects a bad log offset", () => {
    expect(() => snapshotRun({ eventSeq: -1 })).toThrow(/non-negative integer/);
    expect(() => snapshotRun({ eventSeq: 1.5 })).toThrow(/non-negative integer/);
  });

  it("builds a checkpoint pointer from a sandbox commit", () => {
    const ref = toCheckpointRef({
      id: "cp2",
      eventSeq: 4,
      checkpoint: { sha: "abc123" },
      reason: "step_landed",
      runId: "run-b",
      label: "after step 2",
    });
    expect(ref).toEqual({
      id: "cp2",
      eventSeq: 4,
      sandboxRef: "abc123",
      reason: "step_landed",
      runId: "run-b",
      label: "after step 2",
    });
  });
});

// ---------------------------------------------------------------------------
// CheckpointStore contract — the in-memory implementation a consumer mirrors
// ---------------------------------------------------------------------------

/**
 * In-memory `CheckpointStore`. Models the Postgres unique indexes exactly:
 * `(threadId, eventKey)` on the log and `(threadId, eventSeq, sandboxRef)` on
 * the pointers, both insert-only (no read-then-write). This is the contract a
 * consumer implements against; when its Postgres store diverges, this shape
 * shows how.
 */
class MemoryCheckpointStore implements CheckpointStore {
  private readonly events = new Map<string, ThreadEvent[]>();
  private readonly checkpoints = new Map<string, Map<string, CheckpointRef>>();
  /** The (threadId, eventSeq, sandboxRef) unique index, as a set of keys. */
  private readonly pointerKeys = new Set<string>();

  async append(
    threadId: string,
    events: ThreadEvent[],
  ): Promise<AppendResult> {
    const log = this.events.get(threadId) ?? [];
    const seen = new Set(log.map((event) => event.eventKey));
    let seq = log.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
    const appended: ThreadEvent[] = [];
    const duplicateKeys: string[] = [];
    for (const event of events) {
      if (seen.has(event.eventKey)) {
        duplicateKeys.push(event.eventKey);
        continue;
      }
      seen.add(event.eventKey);
      seq += 1;
      const stored: ThreadEvent = {
        ...event,
        seq,
        at: event.at ?? "2026-01-01T00:00:00.000Z",
      };
      log.push(stored);
      appended.push(stored);
    }
    this.events.set(threadId, log);
    return { appended, duplicateKeys };
  }

  async since(threadId: string, seq: number): Promise<ThreadEvent[]> {
    return (this.events.get(threadId) ?? [])
      .filter((event) => (event.seq ?? 0) > seq)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  async eventsThrough(threadId: string, seq: number): Promise<ThreadEvent[]> {
    return (this.events.get(threadId) ?? [])
      .filter((event) => (event.seq ?? 0) <= seq)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  async putCheckpoint(threadId: string, checkpoint: CheckpointRef): Promise<void> {
    const pointer = `${threadId}|${checkpoint.eventSeq}|${checkpoint.sandboxRef}`;
    const byId = this.checkpoints.get(threadId) ?? new Map<string, CheckpointRef>();
    // The (threadId, eventSeq, sandboxRef) unique index: a duplicate is a
    // no-op, not an error.
    if (byId.has(checkpoint.id) || this.pointerKeys.has(pointer)) return;
    this.pointerKeys.add(pointer);
    byId.set(checkpoint.id, { ...checkpoint });
    this.checkpoints.set(threadId, byId);
  }

  async checkpoint(id: string): Promise<CheckpointRef | undefined> {
    for (const byId of this.checkpoints.values()) {
      const found = byId.get(id);
      if (found !== undefined) return { ...found };
    }
    return undefined;
  }

  async latest(threadId: string): Promise<CheckpointRef | undefined> {
    const byId = this.checkpoints.get(threadId);
    if (byId === undefined) return undefined;
    const all = [...byId.values()].sort((a, b) => b.eventSeq - a.eventSeq);
    return all[0] === undefined ? undefined : { ...all[0] };
  }
}

describe("CheckpointStore contract", () => {
  const events: ThreadEvent[] = [
    { kind: "message", eventKey: "message:m1", payload: { text: "hi" } },
    {
      kind: "step_finished",
      eventKey: "step:t1:i1:1:ok",
      payload: { ok: true },
    },
  ];

  it("appends once and reports the same keys as duplicates on a retry", async () => {
    const store = new MemoryCheckpointStore();
    const first = await store.append("th", events);
    expect(first.appended.map((event) => event.eventKey)).toEqual([
      "message:m1",
      "step:t1:i1:1:ok",
    ]);
    expect(first.duplicateKeys).toEqual([]);
    expect(first.appended.map((event) => event.seq)).toEqual([1, 2]);

    const second = await store.append("th", events);
    expect(second.appended).toEqual([]);
    expect(second.duplicateKeys).toEqual([
      "message:m1",
      "step:t1:i1:1:ok",
    ]);
    // The log did not grow: one write per key.
    expect(await store.since("th", 0)).toHaveLength(2);
  });

  it("appends only the new events in a mixed batch", async () => {
    const store = new MemoryCheckpointStore();
    await store.append("th", events);
    const mixed = await store.append("th", [
      events[0]!,
      { kind: "message", eventKey: "message:m2", payload: { text: "again" } },
    ]);
    expect(mixed.duplicateKeys).toEqual(["message:m1"]);
    expect(mixed.appended.map((event) => event.eventKey)).toEqual([
      "message:m2",
    ]);
    expect(mixed.appended[0]!.seq).toBe(3);
  });

  it("scopes events and checkpoints per thread", async () => {
    const store = new MemoryCheckpointStore();
    await store.append("th-a", events);
    await store.append("th-b", [events[1]!]);
    expect(await store.since("th-a", 0)).toHaveLength(2);
    expect(await store.since("th-b", 0)).toHaveLength(1);
  });

  it("splits the log by seq for since and eventsThrough", async () => {
    const store = new MemoryCheckpointStore();
    await store.append("th", events);
    expect((await store.since("th", 1)).map((event) => event.seq)).toEqual([2]);
    expect(
      (await store.eventsThrough("th", 1)).map((event) => event.seq),
    ).toEqual([1]);
  });

  it("stores checkpoints and returns the newest by eventSeq", async () => {
    const store = new MemoryCheckpointStore();
    const cp2: CheckpointRef = {
      id: "cp2",
      eventSeq: 4,
      sandboxRef: "sha4",
      reason: "step_landed",
    };
    const cp1: CheckpointRef = {
      id: "cp1",
      eventSeq: 2,
      sandboxRef: "sha2",
      reason: "manual",
    };
    await store.putCheckpoint("th", cp2);
    await store.putCheckpoint("th", cp1);
    expect(await store.checkpoint("cp2")).toEqual(cp2);
    expect(await store.latest("th")).toEqual(cp2);
  });
});

// ---------------------------------------------------------------------------
// Engine wiring — an effectful call's journal carries the key
// ---------------------------------------------------------------------------

const strategy: AgentStrategy = {
  name: "test",
  phases: [{ id: "work", goal: "do the work" }],
  systemPrompt: () => "You are a test agent.",
};

describe("effectful tool-call journaling", () => {
  it("carries the same work-derived eventKey on the intent and the result", async () => {
    const events: AgentEvent[] = [];
    const tool = defineTool(
      {
        name: "write_record",
        description: "Write one external record.",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
      async () => ({ ok: true, content: "wrote" }),
      { effect: { key: () => "refund:order_1", idempotent: true } },
    );
    const llm = scripted([
      call("write_record", { value: "x" }),
      { text: "Done." },
    ]);

    const result = await runAgent(userTurn("write it"), {
      llm,
      strategy,
      tools: [tool],
      operations: { store: new MemoryOperationStore(), scope: "th" },
      onEvent: (event) => events.push(event),
    });

    expect(result.reason).toBe("finished");
    const intent = events.find(
      (event) => event.type === "tool_call" && event.name === "write_record",
    );
    const observed = events.find(
      (event) => event.type === "tool_result" && event.name === "write_record",
    );
    expect(intent).toMatchObject({
      eventKey: "tool:write_record:refund:order_1",
    });
    expect(observed).toMatchObject({
      eventKey: "tool:write_record:refund:order_1",
    });
  });

  it("leaves a read-only call's journal free of an eventKey", async () => {
    const events: AgentEvent[] = [];
    const tool = defineTool(
      {
        name: "peek",
        description: "Read only.",
        parameters: { type: "object", properties: {} },
      },
      async () => ({ ok: true, content: "ok" }),
      { readOnly: true },
    );
    const llm = scripted([call("peek", {}), { text: "Done." }]);

    await runAgent(userTurn("look"), {
      llm,
      strategy,
      tools: [tool],
      onEvent: (event) => events.push(event),
    });

    const intent = events.find(
      (event) => event.type === "tool_call" && event.name === "peek",
    );
    expect(intent).toMatchObject({ type: "tool_call", name: "peek" });
    expect(intent?.type === "tool_call" && intent.eventKey).toBeUndefined();
  });

  it("emits no key for an effect with no domain key, so a resume cannot mistake it for a duplicate", async () => {
    const events: AgentEvent[] = [];
    const tool = defineTool(
      {
        name: "write_record",
        description: "Write one external record.",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
      async () => ({ ok: true, content: "wrote" }),
      { effect: { idempotent: true } },
    );
    const llm = scripted([
      call("write_record", { value: "x" }),
      { text: "Done." },
    ]);

    await runAgent(userTurn("write it"), {
      llm,
      strategy,
      tools: [tool],
      operations: { store: new MemoryOperationStore(), scope: "th" },
      onEvent: (event) => events.push(event),
    });

    const intent = events.find(
      (event) => event.type === "tool_call" && event.name === "write_record",
    );
    expect(intent?.type === "tool_call" && intent.eventKey).toBeUndefined();
  });
});
