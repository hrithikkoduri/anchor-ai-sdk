import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import {
  MemoryInboxStore,
  renderInboxTurn,
  type InboxMessage,
} from "../../src/engine/inbox.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import type { AgentEvent } from "../../src/engine/events.js";
import type { EngineOptions } from "../../src/engine/types.js";
import { chatAgent } from "../../src/agents/chat/index.js";
import { defineTool } from "../../src/tools/types.js";
import { bashTool } from "../../src/tools/bash.js";
import type { ExecResult, Sandbox } from "../../src/sandbox/types.js";
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

/** A scripted model that runs `onCall` before answering call `n`. */
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
  channel: string,
  text: string,
  delivery: InboxMessage["delivery"],
): InboxMessage => ({
  id: `m${++seq}`,
  channel,
  text,
  delivery,
});

const base: Pick<EngineOptions, "agent" | "tools" | "snapshot"> = {
  agent: chatAgent,
  tools: [noop],
  snapshot: false,
};

describe("runAgent without an inbox", () => {
  it("is exactly one run, with no chain surface", async () => {
    const result = await runAgent(
      userTurn("say hi"),
      { ...base, llm: scripted([{ text: "hi" }]) },
    );
    expect(result.runs).toBeUndefined();
    expect(result.reason).toBe("finished");
  });
});

describe("queued messages", () => {
  it("wait for the run to finish, then become the next run", async () => {
    const store = new MemoryInboxStore();
    const thread = new MemoryThreadStore();
    const llm = model(
      [call("noop"), { text: "first done" }, { text: "second done" }],
      async (n) => {
        if (n === 1)
          await store.push(message("t", "Also add a test", "queue"));
      },
    );
    const result = await runAgent(
      userTurn("Fix the retry bug"),
      {
        ...base,
        llm,
        inbox: { store, channel: "t" },
        thread: { store: thread, id: "t" },
      },
    );

    expect(result.summary).toBe("second done");
    expect(result.runs?.map((run) => run.reason)).toEqual([
      "finished",
      "finished",
    ]);
    expect(store.pendingCount("t")).toBe(0);

    // The second run starts from the queued message, with the first run's
    // conversation still in front of it.
    const second = llm.seen[2]!;
    const contents = second.messages.map((m) => m.content ?? "");
    expect(contents).toContain("Also add a test");
    expect(contents.some((text) => text.includes("first done"))).toBe(true);
  });

  it("coalesce into a single next run, in arrival order", async () => {
    const store = new MemoryInboxStore();
    const llm = model([call("noop"), { text: "one" }, { text: "two" }], async (n) => {
      if (n !== 1) return;
      await store.push(message("t", "first note", "queue"));
      await store.push(message("t", "second note", "queue"));
    });
    const result = await runAgent(
      userTurn("start"),
      { ...base, llm, inbox: { store, channel: "t" } },
    );

    expect(result.runs).toHaveLength(2);
    const task = llm.seen[2]!.messages.at(-1)!.content ?? "";
    expect(task.indexOf("first note")).toBeLessThan(task.indexOf("second note"));
  });

  it("accept a caller-supplied renderer", async () => {
    const store = new MemoryInboxStore();
    const llm = model([call("noop"), { text: "one" }, { text: "two" }], async (n) => {
      if (n === 1) await store.push(message("t", "note", "queue"));
    });
    await runAgent(
      userTurn("start"),
      {
        ...base,
        llm,
        inbox: {
          store,
          channel: "t",
          render: (messages) =>
            userTurn(
              `[inbox] ${messages.map((m) => m.text).join(" + ")}`,
            ),
        },
      },
    );
    expect(llm.seen[2]!.messages.at(-1)!.content).toBe("[inbox] note");
  });
});

describe("interjections", () => {
  it("end the run at the next boundary and start the next run with them", async () => {
    const store = new MemoryInboxStore();
    const events: AgentEvent[] = [];
    const llm = model(
      [call("noop"), { text: "redirected" }],
      async (n) => {
        if (n === 1)
          await store.push(message("t", "Bug is in timeout", "interject"));
      },
    );
    const result = await runAgent(
      userTurn("Fix the retry bug"),
      {
        ...base,
        llm,
        inbox: { store, channel: "t" },
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    expect(result.runs?.map((run) => run.reason)).toEqual([
      "interrupted",
      "finished",
    ]);
    expect(result.summary).toBe("redirected");
    expect(store.pendingCount("t")).toBe(0);
    expect(events.some((event) => event.type === "inbox_interject")).toBe(true);
    expect(events.some((event) => event.type === "inbox_delivered")).toBe(true);
  });

  it("let the newest correction supersede an older one", async () => {
    const store = new MemoryInboxStore();
    const llm = model([call("noop"), { text: "done" }], async (n) => {
      if (n !== 1) return;
      await store.push(message("t", "older correction", "interject"));
      await store.push(message("t", "newest correction", "interject"));
    });
    await runAgent(
      userTurn("start"),
      { ...base, llm, inbox: { store, channel: "t" } },
    );

    const task = llm.seen[1]!.messages.at(-1)!.content ?? "";
    expect(task.indexOf("newest correction")).toBeLessThan(
      task.indexOf("older correction"),
    );
  });
});

describe("chain boundaries", () => {
  it("shares one budget across runs", async () => {
    const store = new MemoryInboxStore();
    const llm = model(
      [call("noop"), { text: "first" }, call("noop")],
      async (n) => {
        if (n === 1) await store.push(message("t", "more work", "queue"));
      },
    );
    const result = await runAgent(
      userTurn("start"),
      { ...base, llm, budgets: { maxSteps: 3 }, inbox: { store, channel: "t" } },
    );

    expect(result.runs).toHaveLength(2);
    expect(result.runs?.[0]?.steps).toBe(2);
    expect(result.runs?.[1]?.steps).toBe(1);
    // Run two starts at 2/3 steps and hits the shared ceiling on its next turn.
    expect(result.reason).toBe("max_steps");
  });

  it("reports per-run usage without double-counting the chain", async () => {
    const store = new MemoryInboxStore();
    const llm = model([call("noop"), { text: "one" }, { text: "two" }], async (n) => {
      if (n === 1) await store.push(message("t", "more", "queue"));
    });
    const result = await runAgent(
      userTurn("start"),
      { ...base, llm, inbox: { store, channel: "t" } },
    );

    const [first, second] = result.runs!;
    // Each scripted call is 15 tokens: run one made two calls, run two one.
    expect(first!.usage.totalTokens).toBe(30);
    expect(second!.usage.totalTokens).toBe(15);
    // The result carries the chain total, which the summaries add up to.
    expect(result.usage.totalTokens).toBe(45);
    expect(first!.usage.totalTokens + second!.usage.totalTokens).toBe(
      result.usage.totalTokens,
    );
  });

  it("stops on cancellation instead of claiming more work", async () => {
    const store = new MemoryInboxStore();
    const controller = new AbortController();
    const llm = model([call("noop")], async (n) => {
      if (n !== 1) return;
      await store.push(message("t", "left waiting", "queue"));
      controller.abort();
    });
    const result = await runAgent(
      userTurn("start"),
      {
        ...base,
        llm,
        inbox: { store, channel: "t" },
        signal: controller.signal,
      },
    );

    expect(result.reason).toBe("cancelled");
    expect(store.pendingCount("t")).toBe(1);
  });

  it("releases the claimed batch when the next run errors", async () => {
    const store = new MemoryInboxStore();
    const llm = model([call("noop"), { text: "first" }], async (n) => {
      if (n === 1) await store.push(message("t", "this run will fail", "queue"));
    });
    // Turn three is missing: the scripted model throws inside run two.
    const result = await runAgent(
      userTurn("start"),
      { ...base, llm, inbox: { store, channel: "t" } },
    );

    expect(result.reason).toBe("error");
    expect(store.pendingCount("t")).toBe(1);
  });
});

describe("background jobs across a chain", () => {
  const completed = (stdout = "job output\n"): ExecResult => ({
    exitCode: 0,
    stdout,
    stderr: "",
    output: stdout,
    timedOut: false,
    durationMs: 10,
  });
  const backgrounded: ExecResult = {
    exitCode: -1,
    stdout: "",
    stderr: "",
    output: "still running",
    timedOut: false,
    durationMs: 5_000,
    background: { jobId: "job-1" },
  };

  it("carries a still-running job into the run an interjection starts", async () => {
    const store = new MemoryInboxStore();
    let polls = 0;
    const sandbox: Sandbox = {
      id: "sb-test",
      backend: "fake",
      workspace: "/workspace/repo",
      scratch: "/workspace/.anchor",
      start: async () => undefined,
      exec: async (_command, opts) => (opts?.backgroundAfterSecs ? backgrounded : completed()),
      pollJob: async () => (++polls >= 2 ? completed() : undefined),
      killJob: async () => true,
      checkpoint: async () => ({ sha: "0".repeat(40), message: "", at: 0 }),
      hasChangesFrom: async () => false,
      fork: async () => {
        throw new Error("not supported");
      },
      destroy: async () => undefined,
    };
    const llm = model(
      [
        call("bash", { command: "sleep 300" }),
        { text: "after the interjection" },
        // The injected job result is a turn of its own: the model answers it.
        { text: "job acknowledged" },
      ],
      async (n) => {
        if (n === 1)
          await store.push(message("t", "switch tasks", "interject"));
      },
    );

    const result = await runAgent(
      userTurn("start"),
      {
        agent: chatAgent,
        tools: [bashTool],
        snapshot: false,
        llm,
        sandbox,
        backgroundAfterSecs: 120,
        inbox: { store, channel: "t" },
      },
    );

    expect(result.runs?.map((run) => run.reason)).toEqual([
      "interrupted",
      "finished",
    ]);
    // The job detached in run one was polled again in run two and delivered
    // there, without the consumer touching pendingJobs/resumeJobs.
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(llm.seen.at(-1)!.messages.map((m) => m.content ?? "").join("\n")).toContain(
      "Background job job-1",
    );
  });
});

describe("background jobs with inbox work waiting", () => {
  it("finishes immediately and carries the job into the next run", async () => {
    const store = new MemoryInboxStore();
    let polls = 0;
    const completed = (stdout = "job output\\n"): ExecResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      output: stdout,
      timedOut: false,
      durationMs: 10,
    });
    const sandbox: Sandbox = {
      id: "sb-test",
      backend: "fake",
      workspace: "/workspace/repo",
      scratch: "/workspace/.anchor",
      start: async () => undefined,
      exec: async (_command, opts) =>
        opts?.backgroundAfterSecs
          ? {
              exitCode: -1,
              stdout: "",
              stderr: "",
              output: "still running",
              timedOut: false,
              durationMs: 5_000,
              background: { jobId: "job-2" },
            }
          : completed(),
      pollJob: async () => (++polls >= 2 ? completed() : undefined),
      killJob: async () => true,
      checkpoint: async () => ({ sha: "0".repeat(40), message: "", at: 0 }),
      hasChangesFrom: async () => false,
      fork: async () => {
        throw new Error("not supported");
      },
      destroy: async () => undefined,
    };
    // A queued message is waiting from the start; the run must not wait for
    // the job before finishing.
    await store.push(message("t", "queued task", "queue"));
    const llm = model([
      call("bash", { command: "sleep 300" }), // run one, turn one
      { text: "queued answered" }, // run one ends; the job is carried
      { text: "job acknowledged" }, // run two, which absorbs the job
      { text: "done" },
    ]);

    const result = await runAgent(
      userTurn("start"),
      {
        agent: chatAgent,
        tools: [bashTool],
        snapshot: false,
        llm,
        sandbox,
        backgroundAfterSecs: 120,
        inbox: { store, channel: "t" },
      },
    );

    expect(result.runs).toHaveLength(2);
    // Run one ended without absorbing the job. Run two's FIRST call carries
    // both the queued task (its request) and the job it inherited, because the
    // top-of-turn poll runs before that call.
    const secondRunFirstCall = llm.seen[2]!.messages
      .map((m) => m.content ?? "")
      .join("\n");
    expect(secondRunFirstCall).toContain("queued task");
    expect(secondRunFirstCall).toContain("Background job job-2");
    expect(polls).toBeGreaterThanOrEqual(2);
  });
});

describe("MemoryInboxStore", () => {
  it("claims interjections newest-first, then queued oldest-first", async () => {
    const store = new MemoryInboxStore();
    const first = message("t", "queued one", "queue");
    const urgent = message("t", "urgent", "interject");
    const second = message("t", "queued two", "queue");
    expect(await store.push(first)).toBe("queued");
    expect(await store.push(urgent)).toBe("queued");
    expect(await store.push(second)).toBe("queued");

    expect(await store.hasInterject("t")).toBe(true);
    const batch = await store.claimAll("t");
    expect(batch.map((item) => item.text)).toEqual([
      "urgent",
      "queued one",
      "queued two",
    ]);
    expect(await store.hasInterject("t")).toBe(false);
    expect(await store.claimAll("t")).toEqual([]);

    await store.complete(batch.map((item) => item.id));
    expect(store.pendingCount("t")).toBe(0);
  });

  it("rejects a message without an id, channel, or text", async () => {
    const store = new MemoryInboxStore();
    const valid = message("t", "hello", "queue");
    await expect(store.push({ ...valid, id: "" })).rejects.toThrow(/needs an id/);
    await expect(store.push({ ...valid, channel: "" })).rejects.toThrow(
      /needs a channel/,
    );
    await expect(store.push({ ...valid, text: "  " })).rejects.toThrow(
      /needs text/,
    );
  });

  it("deduplicates by id and isolates channels", async () => {
    const store = new MemoryInboxStore();
    const item = message("a", "hello", "queue");
    expect(await store.push(item)).toBe("queued");
    expect(await store.push(item)).toBe("duplicate");
    expect(await store.push({ ...item, channel: "b" })).toBe("queued");

    expect(await store.claimAll("a")).toHaveLength(1);
    expect(await store.claimAll("b")).toHaveLength(1);
  });

  it("returns a released batch to pending, but never a completed one", async () => {
    const store = new MemoryInboxStore();
    const item = message("t", "retry me", "queue");
    await store.push(item);
    const [claimed] = await store.claimAll("t");
    await store.release([claimed!.id]);
    expect(store.pendingCount("t")).toBe(1);

    const [again] = await store.claimAll("t");
    await store.complete([again!.id]);
    await store.release([again!.id]);
    expect(store.pendingCount("t")).toBe(0);
  });
});

describe("renderInboxTurn", () => {
  it("keeps one message per row and separates context", async () => {
    const rendered = renderInboxTurn([
      {
        id: "1",
        channel: "t",
        text: "do this",
        delivery: "interject",
      },
      {
        id: "2",
        channel: "t",
        text: "then that",
        context: "facts",
        delivery: "queue",
      } as InboxMessage,
    ]);
    expect(rendered).toEqual({
      messages: [
        { role: "user", content: "do this" },
        { role: "user", content: "then that" },
      ],
      context: "facts",
    });
  });
});
