/**
 * External-effect recovery: write-ahead intent, stable operation ids, and the
 * rule that an ambiguous write is never replayed.
 *
 * No sandbox and no network: the "target" is an in-memory counter, and the
 * scripted model decides what to call.
 */
import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import type { AgentStrategy } from "../../src/engine/strategy.js";
import type { AgentEvent } from "../../src/engine/events.js";
import {
  MemoryOperationStore,
  type OperationStore,
} from "../../src/engine/operations.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import { defineTool } from "../../src/tools/types.js";
import { call, scripted } from "../helpers/scripted.js";

const strategy: AgentStrategy = {
  name: "test",
  phases: [{ id: "work", goal: "do the work" }],
  systemPrompt: () => "You are a test agent.",
};

const definition = {
  name: "write_record",
  description: "Write one external record.",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
};

describe("external effect recovery", () => {
  it("journals intent before the tool runs and passes the operation id", async () => {
    const log: string[] = [];
    let seenOperationId: string | undefined;
    const store = new MemoryOperationStore();
    const originalBegin = store.begin.bind(store);
    store.begin = async (operation) => {
      log.push("begin");
      return originalBegin(operation);
    };
    const tool = defineTool(
      definition,
      async (input, ctx) => {
        log.push("run");
        seenOperationId = ctx.operationId;
        await ctx.acknowledge?.({ requestId: "req_1" });
        return { ok: true, content: `wrote ${String(input.value)}` };
      },
      { effect: { idempotent: true } },
    );
    const events: AgentEvent[] = [];
    const llm = scripted([
      call("write_record", { value: "x" }),
      { text: "Done." },
    ]);

    const result = await runAgent(
      { task: "write it" },
      {
        llm,
        strategy,
        tools: [tool],
        operations: { store, scope: "thread-1" },
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.reason).toBe("finished");
    expect(log).toEqual(["begin", "run"]);
    expect(seenOperationId).toMatch(/^op_/);
    expect(store.get(seenOperationId!)?.settled?.status).toBe("completed");

    const intent = events.find(
      (event) => event.type === "tool_call" && event.name === "write_record",
    );
    expect(intent?.type === "tool_call" && intent.operationId).toBe(
      seenOperationId,
    );
    const ack = events.find((event) => event.type === "tool_ack");
    expect(ack?.type === "tool_ack" && ack.ack).toEqual({
      requestId: "req_1",
    });
    const observed = events.find(
      (event) => event.type === "tool_result" && event.name === "write_record",
    );
    expect(observed).toMatchObject({
      type: "tool_result",
      outcome: "completed",
      operationId: seenOperationId,
    });
  });

  it("stops before the model when a pending outcome is unknown", async () => {
    const store = new MemoryOperationStore();
    await store.begin({
      operationId: "op_pending",
      scope: "thread-1",
      tool: "write_record",
      input: { value: "x" },
      status: "intent",
      startedAt: Date.now(),
    });
    let runs = 0;
    const tool = defineTool(
      definition,
      async () => {
        runs++;
        return { ok: true, content: "should not run" };
      },
      {
        effect: {
          reconcile: async () => ({
            status: "unknown",
            detail: "target did not answer",
          }),
        },
      },
    );
    const events: AgentEvent[] = [];
    const llm = scripted([]);

    const result = await runAgent(
      { task: "write it" },
      {
        llm,
        strategy,
        tools: [tool],
        operations: { store, scope: "thread-1" },
        onEvent: (event) => events.push(event),
      },
    );

    expect(llm.seen).toHaveLength(0);
    expect(runs).toBe(0);
    expect(result.reason).toBe("recovery_required");
    expect(result.pendingOperations?.map((op) => op.operationId)).toEqual([
      "op_pending",
    ]);
    expect(events.find((event) => event.type === "reconciled")).toMatchObject({
      status: "unknown",
      operationId: "op_pending",
    });
    expect(store.get("op_pending")?.settled).toBeUndefined();
  });

  it("adopts an applied operation instead of replaying it", async () => {
    const store = new MemoryOperationStore();
    await store.begin({
      operationId: "op_applied",
      scope: "t1",
      tool: "write_record",
      input: { value: "x" },
      status: "intent",
      startedAt: Date.now(),
    });
    let runs = 0;
    const tool = defineTool(
      definition,
      async () => {
        runs++;
        return { ok: true, content: "duplicate" };
      },
      {
        effect: {
          reconcile: async () => ({
            status: "applied",
            result: { ok: true, content: "record 42" },
          }),
        },
      },
    );
    const llm = scripted([{ text: "Finished." }]);

    const result = await runAgent(
      { task: "write it" },
      {
        llm,
        strategy,
        tools: [tool],
        thread: { store: new MemoryThreadStore(), id: "t1" },
        operations: { store },
      },
    );

    expect(result.reason).toBe("finished");
    expect(runs).toBe(0);
    expect(store.get("op_applied")?.settled?.status).toBe("completed");
    expect(
      llm.seen[0]!.messages.some(
        (message) =>
          message.role === "user" &&
          message.content?.includes("already applied") &&
          message.content.includes("record 42"),
      ),
    ).toBe(true);
  });

  it("settles a not-applied operation and lets the run continue", async () => {
    const store = new MemoryOperationStore();
    await store.begin({
      operationId: "op_missing",
      scope: "t2",
      tool: "write_record",
      input: { value: "x" },
      status: "intent",
      startedAt: Date.now(),
    });
    const tool = defineTool(
      definition,
      async () => ({ ok: true, content: "wrote" }),
      { effect: { reconcile: async () => ({ status: "not_applied" }) } },
    );
    const llm = scripted([{ text: "Finished." }]);

    const result = await runAgent(
      { task: "write it" },
      {
        llm,
        strategy,
        tools: [tool],
        thread: { store: new MemoryThreadStore(), id: "t2" },
        operations: { store },
      },
    );

    expect(result.reason).toBe("finished");
    expect(store.get("op_missing")?.settled?.status).toBe("failed");
    expect(
      llm.seen[0]!.messages.some((message) =>
        message.content?.includes("was NOT applied"),
      ),
    ).toBe(true);
  });

  it("fails closed when the intent cannot be recorded", async () => {
    const store: OperationStore = {
      loadPending: async () => [],
      begin: async () => {
        throw new Error("journal unavailable");
      },
      acknowledge: async () => undefined,
      settle: async () => undefined,
    };
    let runs = 0;
    const tool = defineTool(
      definition,
      async () => {
        runs++;
        return { ok: true, content: "wrote" };
      },
      { effect: { idempotent: true } },
    );
    const events: AgentEvent[] = [];
    const llm = scripted([
      call("write_record", { value: "x" }),
      { text: "Done." },
    ]);

    const result = await runAgent(
      { task: "write it" },
      {
        llm,
        strategy,
        tools: [tool],
        operations: { store, scope: "t3" },
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.reason).toBe("finished");
    expect(runs).toBe(0);
    expect(
      events.find(
        (event) =>
          event.type === "tool_result" && event.name === "write_record",
      ),
    ).toMatchObject({ ok: false, outcome: "failed" });
  });

  it("advises when an effectful tool has no operation store", async () => {
    let seenOperationId: string | undefined = "unset";
    const tool = defineTool(
      definition,
      async (_input, ctx) => {
        seenOperationId = ctx.operationId;
        return { ok: true, content: "wrote" };
      },
      { effect: { idempotent: true } },
    );
    const events: AgentEvent[] = [];
    const llm = scripted([
      call("write_record", { value: "x" }),
      { text: "Done." },
    ]);

    const result = await runAgent(
      { task: "write it" },
      {
        llm,
        strategy,
        tools: [tool],
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.reason).toBe("finished");
    expect(seenOperationId).toBeUndefined();
    expect(
      events.find(
        (event) =>
          event.type === "advisory" &&
          event.kind === "effect_without_journal",
      ),
    ).toBeDefined();
  });

  it("settles only after the conversation is durable", async () => {
    const order: string[] = [];
    class RecordingThreadStore extends MemoryThreadStore {
      override async save(
        id: string,
        thread: Parameters<MemoryThreadStore["save"]>[1],
      ): Promise<void> {
        order.push("save");
        return super.save(id, thread);
      }
    }
    const store = new MemoryOperationStore();
    const originalSettle = store.settle.bind(store);
    store.settle = async (operationId, result) => {
      order.push("settle");
      return originalSettle(operationId, result);
    };
    const tool = defineTool(
      definition,
      async () => ({ ok: true, content: "wrote" }),
      { effect: { idempotent: true } },
    );
    const llm = scripted([
      call("write_record", { value: "x" }),
      { text: "Done." },
    ]);

    await runAgent(
      { task: "write it" },
      {
        llm,
        strategy,
        tools: [tool],
        thread: { store: new RecordingThreadStore(), id: "t4" },
        operations: { store },
      },
    );

    expect(order.slice(0, 2)).toEqual(["save", "settle"]);
  });

  it("leaves the operation pending when the thread cannot be saved", async () => {
    class FailingThreadStore extends MemoryThreadStore {
      override async save(): Promise<void> {
        throw new Error("thread store down");
      }
    }
    const store = new MemoryOperationStore();
    const begun: string[] = [];
    const originalBegin = store.begin.bind(store);
    store.begin = async (operation) => {
      begun.push(operation.operationId);
      return originalBegin(operation);
    };
    const tool = defineTool(
      definition,
      async () => ({ ok: true, content: "wrote" }),
      { effect: { idempotent: true } },
    );
    const llm = scripted([
      call("write_record", { value: "x" }),
      { text: "Done." },
    ]);

    await runAgent(
      { task: "write it" },
      {
        llm,
        strategy,
        tools: [tool],
        thread: { store: new FailingThreadStore(), id: "t4" },
        operations: { store },
      },
    );

    expect(begun).toHaveLength(1);
    expect(store.get(begun[0]!)?.settled).toBeUndefined();
    expect(await store.loadPending("t4")).toHaveLength(1);
  });

  it("keeps a tool-declared unknown outcome recoverable", async () => {
    const store = new MemoryOperationStore();
    const begun: string[] = [];
    const originalBegin = store.begin.bind(store);
    store.begin = async (operation) => {
      begun.push(operation.operationId);
      return originalBegin(operation);
    };
    const events: AgentEvent[] = [];
    const llm = scripted([
      call("write_record", { value: "x" }),
      { text: "Done." },
    ]);
    const tool = defineTool(
      definition,
      async () => ({
        ok: false,
        completion: "unknown",
        content: "the response was lost after the request was sent",
      }),
      { effect: { idempotent: true } },
    );

    await runAgent(
      { task: "write it" },
      {
        llm,
        strategy,
        tools: [tool],
        operations: { store, scope: "t6" },
        onEvent: (event) => events.push(event),
      },
    );

    expect(
      events.find(
        (event) =>
          event.type === "tool_result" && event.name === "write_record",
      ),
    ).toMatchObject({ outcome: "unknown" });
    expect(store.get(begun[0]!)?.settled?.status).toBe("unknown");
    expect(await store.loadPending("t6")).toHaveLength(1);
  });

  it("does not repeat a domain key that is already recorded", async () => {
    const store = new MemoryOperationStore();
    await store.begin({
      operationId: "refund:order_1",
      scope: "t5",
      tool: "write_record",
      input: { value: "x" },
      status: "intent",
      startedAt: Date.now(),
    });
    await store.settle("refund:order_1", {
      status: "completed",
      ok: true,
      content: "already refunded",
    });
    let runs = 0;
    const events: AgentEvent[] = [];
    const tool = defineTool(
      definition,
      async () => {
        runs++;
        return { ok: true, content: "duplicate" };
      },
      { effect: { key: () => "refund:order_1" } },
    );
    const llm = scripted([
      call("write_record", { value: "x" }),
      { text: "Done." },
    ]);

    await runAgent(
      { task: "write it" },
      {
        llm,
        strategy,
        tools: [tool],
        operations: { store, scope: "t5" },
        onEvent: (event) => events.push(event),
      },
    );

    expect(runs).toBe(0);
    expect(
      events.find(
        (event) =>
          event.type === "tool_result" && event.name === "write_record",
      ),
    ).toMatchObject({ ok: false, outcome: "failed" });
  });
});
