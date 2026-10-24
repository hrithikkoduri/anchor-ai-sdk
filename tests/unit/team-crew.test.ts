import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import { userTurn } from "../../src/engine/types.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import { defineTool, type Tool } from "../../src/tools/types.js";
import { createLiveProjector } from "../../src/trace/live-projector.js";
import { projectConversation } from "../../src/trace/conversation.js";
import { scripted } from "../helpers/scripted.js";
import { createCodingAgent } from "../../src/agents/coding/index.js";
import type { Agent } from "../../src/agents/types.js";
import type { AgentEvent } from "../../src/engine/events.js";
import type { TeamWorkspaceRequest } from "../../src/teams/types.js";
import { scopedSandbox } from "../../src/sandbox/scoped.js";
import type { Sandbox } from "../../src/sandbox/types.js";

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

const delegate = (args: Record<string, unknown>) => ({
  name: "delegate",
  arguments: JSON.stringify(args),
});

/** Resolves only once `count` callers are inside it at the same time. */
function barrier(count: number) {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return defineTool(
    { name: "meet", description: "wait for the others", parameters: { type: "object", properties: {} } },
    async () => {
      arrived += 1;
      if (arrived >= count) open();
      const timeout = new Promise<"alone">((resolve) => setTimeout(() => resolve("alone"), 500));
      const outcome = await Promise.race([opened.then(() => "together" as const), timeout]);
      return { ok: outcome === "together", content: outcome };
    },
  );
}

describe("a crew: worker instances, memory, parallel work, workspaces", () => {
  it("names the worker and attributes its events to it, under its member", async () => {
    const events: AgentEvent[] = [];
    const result = await runAgent(userTurn("build it"), {
      llm: scripted([{ tools: [delegate({ agent: "frontend", worker: "frontend-2", task: "build the page" })] }, { text: "done" }]),
      agent: agent("captain"),
      team: { members: { frontend: { agent: agent("frontend"), role: "worker", llm: scripted([{ text: "page built" }]) } } },
      onEvent: (event) => events.push(event),
    });
    expect(result.ok).toBe(true);
    const finished = events.find((e) => e.type === "tool_result" && e.name === "delegate");
    expect(finished).toMatchObject({ ok: true, meta: { agent: "frontend", worker: "frontend-2", role: "worker", resumed: false } });
    const child = events.filter((e) => e.worker === "frontend-2");
    expect(child.length).toBeGreaterThan(0);
    expect(child.every((e) => e.agent === "frontend" && e.role === "worker" && e.parentAgent === "captain")).toBe(true);
  });

  it("rejects a bad worker name and a worker reused for another role", async () => {
    const results: AgentEvent[] = [];
    await runAgent(userTurn("go"), {
      llm: scripted([
        { tools: [delegate({ agent: "frontend", worker: "Front End", task: "x" })] },
        { tools: [delegate({ agent: "frontend", worker: "w1", task: "x" })] },
        { tools: [delegate({ agent: "backend", worker: "w1", task: "x" })] },
        { text: "done" },
      ]),
      agent: agent("captain"),
      team: {
        members: {
          frontend: { agent: agent("frontend"), role: "worker", llm: scripted([{ text: "ok" }]) },
          backend: { agent: agent("backend"), role: "worker", llm: scripted([{ text: "ok" }]) },
        },
      },
      onEvent: (event) => {
        if (event.type === "tool_result" && event.name === "delegate" && !event.delegateCallId) results.push(event);
      },
    });
    expect(results.map((e) => (e as { ok: boolean }).ok)).toEqual([false, true, false]);
    expect((results[2] as { content: string }).content).toContain('"w1" is a frontend');
  });

  it("a worker remembers its earlier task; fresh starts it over", async () => {
    const child = scripted([{ text: "built v1" }, { text: "fixed it" }, { text: "started over" }]);
    const store = new MemoryThreadStore();
    const events: AgentEvent[] = [];
    await runAgent(userTurn("build, then fix, then redo"), {
      llm: scripted([
        { tools: [delegate({ agent: "frontend", worker: "frontend-1", task: "build the page" })] },
        { tools: [delegate({ agent: "frontend", worker: "frontend-1", task: "fix the header", feedback: "header overlaps" })] },
        { tools: [delegate({ agent: "frontend", worker: "frontend-1", task: "redo from scratch", fresh: true })] },
        { text: "done" },
      ]),
      agent: agent("captain"),
      team: {
        members: { frontend: { agent: agent("frontend"), role: "worker", llm: child } },
        sessions: { store, id: (worker) => `t1:${worker}` },
      },
      onEvent: (event) => events.push(event),
    });
    const said = (n: number) => child.seen[n]!.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    // The fix sees what it built before and the review feedback.
    expect(said(1)).toContain("build the page");
    expect(said(1)).toContain("built v1");
    expect(said(1)).toContain("header overlaps");
    // Fresh forgets.
    expect(said(2)).not.toContain("build the page");
    expect(said(2)).toContain("redo from scratch");
    const resumed = events
      .filter((e) => e.type === "tool_result" && e.name === "delegate" && !e.delegateCallId)
      .map((e) => (e as unknown as { meta: { resumed: boolean } }).meta.resumed);
    expect(resumed).toEqual([false, true, false]);
  });

  it("delegations to different workers in one turn run in parallel", async () => {
    const meet = barrier(2);
    const result = await runAgent(userTurn("both at once"), {
      llm: scripted([
        {
          tools: [
            delegate({ agent: "frontend", worker: "frontend-1", task: "ui" }),
            delegate({ agent: "backend", worker: "backend-1", task: "api" }),
          ],
        },
        { text: "done" },
      ]),
      agent: agent("captain"),
      team: {
        members: {
          frontend: { agent: agent("frontend", [meet]), role: "worker", llm: scripted([{ tools: [{ name: "meet", arguments: "{}" }] }, { text: "ui done" }]) },
          backend: { agent: agent("backend", [meet]), role: "worker", llm: scripted([{ tools: [{ name: "meet", arguments: "{}" }] }, { text: "api done" }]) },
        },
      },
    });
    const meetings = result.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(meetings).toEqual(["ui done", "api done"]);
  });

  it("maxParallel bounds how many workers run at once", async () => {
    const meet = barrier(2);
    const events: AgentEvent[] = [];
    await runAgent(userTurn("both at once"), {
      llm: scripted([
        {
          tools: [
            delegate({ agent: "frontend", worker: "frontend-1", task: "ui" }),
            delegate({ agent: "backend", worker: "backend-1", task: "api" }),
          ],
        },
        { text: "done" },
      ]),
      agent: agent("captain"),
      team: {
        maxParallel: 1,
        members: {
          frontend: { agent: agent("frontend", [meet]), role: "worker", llm: scripted([{ tools: [{ name: "meet", arguments: "{}" }] }, { text: "ui done" }]) },
          backend: { agent: agent("backend", [meet]), role: "worker", llm: scripted([{ tools: [{ name: "meet", arguments: "{}" }] }, { text: "api done" }]) },
        },
      },
      onEvent: (event) => events.push(event),
    });
    const met = events.filter((e) => e.type === "tool_result" && e.name === "meet").map((e) => (e as { content: string }).content);
    expect(met).toEqual(["alone", "together"]);
  });

  it("the workspace hook decides where a worker works and tells it", async () => {
    const asked: TeamWorkspaceRequest[] = [];
    const child = scripted([{ text: "continued" }]);
    await runAgent(userTurn("continue the frontend's work"), {
      llm: scripted([{ tools: [delegate({ agent: "backend", worker: "backend-1", task: "wire the api", base: "frontend-1" })] }, { text: "done" }]),
      agent: agent("captain"),
      team: {
        members: { backend: { agent: agent("backend"), role: "worker", llm: child } },
        workspace: async (request) => {
          asked.push(request);
          return { context: `Branch crew/${request.worker}, started from crew/${request.base}.` };
        },
      },
    });
    expect(asked).toEqual([{ worker: "backend-1", member: "backend", role: "worker", readOnly: false, base: "frontend-1", resumed: false }]);
    const told = child.seen[0]!.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(told).toContain("Where you work:\nBranch crew/backend-1, started from crew/frontend-1.");
  });
});

describe("admission: the consumer decides whether a delegation may run", () => {
  it("a refused delegation returns the reason; no workspace, no child run", async () => {
    const child = scripted([{ text: "should not run" }]);
    const workspaces: TeamWorkspaceRequest[] = [];
    const seen: unknown[] = [];
    const events: AgentEvent[] = [];
    await runAgent(userTurn("go"), {
      llm: scripted([{ tools: [delegate({ agent: "backend", worker: "backend-1", task: "write the endpoint", item: "r3" })] }, { text: "done" }]),
      agent: agent("captain"),
      team: {
        members: { backend: { agent: agent("backend"), role: "worker", llm: child } },
        admit: async (request) => {
          seen.push(request);
          return { ok: false, reason: "r3 is waiting for the user to approve r2 (approach)." };
        },
        workspace: async (request) => {
          workspaces.push(request);
          return undefined;
        },
      },
      onEvent: (event) => events.push(event),
    });
    expect(seen).toEqual([{ worker: "backend-1", member: "backend", role: "worker", readOnly: false, task: "write the endpoint", item: "r3" }]);
    expect(workspaces).toEqual([]);
    expect(child.seen).toHaveLength(0);
    const result = events.find((e) => e.type === "tool_result" && e.name === "delegate");
    expect(result).toMatchObject({ ok: false, content: "r3 is waiting for the user to approve r2 (approach).", meta: { refused: true, item: "r3", worker: "backend-1" } });
  });

  it("an admitted delegation carries its item to the workspace and the result", async () => {
    const workspaces: TeamWorkspaceRequest[] = [];
    const events: AgentEvent[] = [];
    const parent = scripted([{ tools: [delegate({ agent: "researcher", task: "map it", item: "r1" })] }, { text: "done" }]);
    await runAgent(userTurn("go"), {
      llm: parent,
      agent: agent("captain"),
      team: {
        members: { researcher: { agent: agent("researcher"), role: "worker", readOnly: true, llm: scripted([{ text: "mapped" }]) } },
        admit: async () => ({ ok: true }),
        workspace: async (request) => {
          workspaces.push(request);
          return undefined;
        },
      },
      onEvent: (event) => events.push(event),
    });
    expect(workspaces[0]).toMatchObject({ item: "r1", worker: "researcher" });
    expect(events.find((e) => e.type === "tool_result" && e.name === "delegate")).toMatchObject({ ok: true, meta: { item: "r1" } });
    // The item parameter is offered only when the consumer checks admission.
    const schema = parent.seen[0]!.tools?.find((t) => t.function.name === "delegate")?.function.parameters as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("item");
  });

  it("without an admission check the item parameter is not offered", async () => {
    const parent = scripted([{ text: "done" }]);
    await runAgent(userTurn("go"), {
      llm: parent,
      agent: agent("captain"),
      team: { members: { researcher: { agent: agent("researcher"), role: "worker", llm: scripted([]) } } },
    });
    const schema = parent.seen[0]!.tools?.find((t) => t.function.name === "delegate")?.function.parameters as { properties: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty("item");
  });
});

describe("a worker in its own tree", () => {
  const fakeSandbox = () => {
    const calls: Array<{ command: string; cwd?: string }> = [];
    let checkpoints = 0;
    let destroyed = false;
    const sandbox: Sandbox = {
      id: "sb",
      backend: "fake",
      workspace: "/work",
      scratch: "/tmp",
      start: async () => undefined,
      exec: async (command, opts = {}) => {
        calls.push({ command, cwd: opts.cwd });
        return { exitCode: 0, stdout: opts.cwd ?? "/work", stderr: "", output: opts.cwd ?? "/work", timedOut: false, durationMs: 0 };
      },
      checkpoint: async () => {
        checkpoints += 1;
        return { ref: "c1" } as never;
      },
      hasChangesFrom: async () => true,
      fork: async () => sandbox,
      destroy: async () => {
        destroyed = true;
      },
    };
    return { sandbox, calls, checkpoints: () => checkpoints, destroyed: () => destroyed };
  };
  const pwd = defineTool(
    { name: "pwd", description: "where am I", parameters: { type: "object", properties: {} } },
    async (_input, ctx) => {
      const result = await ctx.sandbox!.exec("pwd");
      return { ok: true, content: `${result.stdout} repos=${JSON.stringify(ctx.repos ?? [])}` };
    },
    { readOnly: true },
  );

  it("its commands and file tools run in the view's tree, against repos relative to it; its hand-back never checkpoints", async () => {
    const real = fakeSandbox();
    const events: AgentEvent[] = [];
    await runAgent(userTurn("go"), {
      llm: scripted([{ tools: [delegate({ agent: "backend", worker: "backend-1", task: "work" })] }, { text: "done" }]),
      agent: agent("captain"),
      sandbox: real.sandbox,
      repos: [{ name: "app", path: "." }],
      snapshot: false,
      team: {
        members: { backend: { agent: agent("backend", [pwd]), role: "worker", llm: scripted([{ tools: [{ name: "pwd", arguments: "{}" }] }, { text: "worked" }]) } },
        workspace: async ({ worker }) => ({ sandbox: scopedSandbox(real.sandbox, `.crew/${worker}`), repos: [{ name: "app", path: "." }] }),
      },
      onEvent: (event) => events.push(event),
    });
    const said = events.find((e) => e.type === "tool_result" && e.name === "pwd") as { content: string } | undefined;
    expect(said?.content).toBe('/work/.crew/backend-1 repos=[{"name":"app","path":"."}]');
    expect(real.calls.find((c) => c.command === "pwd")?.cwd).toBe("/work/.crew/backend-1");
    expect(real.checkpoints()).toBe(0);
  });

  it("a view never destroys or starts the real sandbox, and an explicit cwd wins", async () => {
    const real = fakeSandbox();
    const view = scopedSandbox(real.sandbox, "/work/.crew/x");
    await view.start();
    await view.destroy();
    expect(real.destroyed()).toBe(false);
    await view.exec("ls", { cwd: "/elsewhere" });
    expect(real.calls.at(-1)).toEqual({ command: "ls", cwd: "/elsewhere" });
    expect(view.workspace).toBe("/work/.crew/x");
  });
});

describe("read-only coding members", () => {
  // The requirement under test is requiredTools; a unit test has no sandbox.
  const codingAgent = () => {
    const base = createCodingAgent();
    return { ...base, strategy: { ...base.strategy, requiresSandbox: false, prepareContext: undefined } };
  };

  it("a coding agent runs as a read-only member though its strategy requires bash and edit_file", async () => {
    const coding = codingAgent();
    const child = scripted([{ text: "reviewed" }]);
    const result = await runAgent(userTurn("review it"), {
      llm: scripted([{ tools: [delegate({ agent: "reviewer", task: "review" })] }, { text: "done" }]),
      agent: agent("captain"),
      team: { members: { reviewer: { agent: { ...coding, name: "reviewer" }, role: "evaluator", llm: child } } },
    });
    expect(result.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["reviewed"]);
    const tools = child.seen[0]!.tools?.map((t) => t.function.name) ?? [];
    expect(tools).toContain("read_file");
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("edit_file");
  });

  it("a requirement the member never had still fails fast", async () => {
    const coding = codingAgent();
    const broken = { ...coding, name: "reviewer", tools: coding.tools.filter((t) => t.definition.name !== "read_file") };
    const result = await runAgent(userTurn("review it"), {
      llm: scripted([{ tools: [delegate({ agent: "reviewer", task: "review" })] }, { text: "done" }]),
      agent: agent("captain"),
      team: { members: { reviewer: { agent: broken, role: "evaluator", llm: scripted([{ text: "x" }]) } } },
    });
    expect(result.messages.filter((m) => m.role === "tool").map((m) => m.content).join("")).toContain("requires tools that were not supplied: read_file");
  });
});

describe("tools know which worker is calling", () => {
  it("passes the worker, member and role in the tool context; the leader gets none", async () => {
    const seen: unknown[] = [];
    const whoami = defineTool(
      { name: "whoami", description: "report the caller", parameters: { type: "object", properties: {} } },
      async (_input, ctx) => {
        seen.push(ctx.team ?? null);
        return { ok: true, content: "noted" };
      },
      { readOnly: true },
    );
    await runAgent(userTurn("go"), {
      llm: scripted([
        { tools: [{ name: "whoami", arguments: "{}" }] },
        { tools: [delegate({ agent: "researcher", worker: "researcher-2", task: "look" })] },
        { text: "done" },
      ]),
      agent: agent("captain", [whoami]),
      team: {
        members: {
          researcher: { agent: agent("researcher", [whoami]), role: "evaluator", llm: scripted([{ tools: [{ name: "whoami", arguments: "{}" }] }, { text: "seen" }]) },
        },
      },
    });
    expect(seen).toEqual([null, { worker: "researcher-2", member: "researcher", role: "evaluator" }]);
  });
});

describe("projections keep a worker's stream apart from its leader's", () => {
  const journal = [
    { seq: 0, type: "run_started", payload: { phases: ["work"] } },
    { seq: 1, type: "llm_call_started", payload: { step: 1 } },
    { seq: 2, type: "llm_call_finished", payload: { step: 1, text: "delegating", usage: {} } },
    { seq: 3, type: "tool_call", payload: { step: 1, name: "delegate", callId: "d1", input: { agent: "frontend", worker: "frontend-1" } } },
    { seq: 4, type: "llm_call_started", payload: { step: 1, agent: "frontend", worker: "frontend-1", role: "worker", delegateCallId: "d1" } },
    { seq: 5, type: "llm_text_delta", payload: { step: 1, text: "worker thinking", delegateCallId: "d1" } },
    { seq: 6, type: "llm_call_finished", payload: { step: 1, text: "worker thinking", usage: {}, delegateCallId: "d1" } },
    { seq: 7, type: "tool_call", payload: { step: 1, name: "read_file", callId: "r1", input: {}, delegateCallId: "d1" } },
    { seq: 8, type: "tool_result", payload: { step: 1, name: "read_file", callId: "r1", ok: true, content: "file", delegateCallId: "d1" } },
  ];

  it("replay nests the worker's transcript in the delegate part", () => {
    const view = projectConversation(journal, "running");
    expect(view.parts.map((p) => p.id)).toEqual(["text-1", "tool-1-d1"]);
    expect(view.parts[0]!.text).toBe("delegating");
    const delegation = view.parts[1]!.delegation!;
    expect(delegation).toMatchObject({ agent: "frontend", worker: "frontend-1", role: "worker", finished: false });
    expect(delegation.parts.map((p) => [p.kind, p.text ?? p.name])).toEqual([
      ["text", "worker thinking"],
      ["tool", "read_file"],
    ]);
    expect(view.sequence).toBe(8);
  });

  it("live frames carry the worker and keep its text separate from the leader's", () => {
    const frames: Array<Record<string, unknown>> = [];
    let clock = 0;
    const live = createLiveProjector((frame) => frames.push(frame), () => (clock += 1000));
    const send = (seq: number, event: AgentEvent) => live.record({ seq, ts: "", event } as never);
    send(1, { type: "llm_call_started", step: 1, phase: "work" } as AgentEvent);
    send(2, { type: "llm_text_delta", text: "lead " } as AgentEvent);
    send(3, { type: "llm_call_started", step: 1, phase: "work", agent: "frontend", worker: "frontend-1", role: "worker", delegateCallId: "d1" } as AgentEvent);
    send(4, { type: "llm_text_delta", text: "worker ", delegateCallId: "d1", worker: "frontend-1" } as AgentEvent);
    send(5, { type: "llm_text_delta", text: "more", delegateCallId: "d1", worker: "frontend-1" } as AgentEvent);
    send(6, { type: "llm_text_delta", text: "text" } as AgentEvent);
    const deltas = frames.filter((f) => f.kind === "delta").map((f) => [f.worker ?? "lead", f.text]);
    expect(deltas).toEqual([
      ["lead", "lead "],
      ["frontend-1", "worker "],
      ["frontend-1", "worker more"],
      ["lead", "lead text"],
    ]);
    expect(frames.find((f) => f.sequence === 3)).toMatchObject({ agent: "frontend", worker: "frontend-1", role: "worker", delegateCallId: "d1" });
    expect(frames.find((f) => f.sequence === 1)).not.toHaveProperty("agent");
  });
});
