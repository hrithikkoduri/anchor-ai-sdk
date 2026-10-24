import { describe, expect, it } from "vitest";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import { MemoryInboxStore } from "../../src/engine/inbox.js";
import {
  createLedger,
  setRequirementStatus,
} from "../../src/ledger/index.js";
import { runAgent, userTurn } from "../../src/engine/loop.js";
import { defineTool } from "../../src/tools/types.js";
import type { Agent } from "../../src/agents/types.js";
import type { AgentEvent } from "../../src/engine/events.js";
import type { Judge } from "../../src/verify/index.js";

function response(
  text: string,
  toolCalls: LLMResponse["toolCalls"] = [],
): LLMResponse {
  return {
    text,
    toolCalls,
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    model: "fake",
    latencyMs: 1,
  };
}

function agentLlm(sequence: LLMResponse[]): LLMClient & {
  seen: LLMRequest[];
} {
  let index = 0;
  const seen: LLMRequest[] = [];
  return {
    model: "fake",
    seen,
    complete: async (req) => {
      seen.push(structuredClone(req));
      throw new Error("unexpected complete call");
    },
    stream: async (req, onDelta) => {
      seen.push(structuredClone(req));
      const item = sequence[index];
      if (!item) throw new Error(`unexpected model call ${index + 1}`);
      index += 1;
      onDelta(item.text);
      return item;
    },
  };
}

const probe = defineTool(
  {
    name: "probe",
    description: "look at the auth code",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  async () => ({ ok: true, content: "refresh happens in src/auth/session.ts:42" }),
  { readOnly: true },
);

const testAgent: Agent = {
  name: "test",
  strategy: {
    name: "test",
    phases: [
      { id: "understand", goal: "establish the request" },
      { id: "act", goal: "do the requested work" },
      { id: "validate", goal: "verify the work" },
    ],
    systemPrompt: () => "test agent",
  },
  tools: [probe],
};

const createTask = (opts: {
  phase?: string;
  required?: boolean;
} = {}) => ({
  id: "create",
  name: "create_task",
  arguments: JSON.stringify({
    goal: "Investigate where auth is refreshed",
    requirements: [
      {
        text: "Find the refresh path",
        required: opts.required ?? true,
        phase: opts.phase ?? "understand",
      },
    ],
  }),
});

function judge(
  verdict: (text: string) => "cleared" | "insufficient" | "unproven",
): Judge {
  return {
    name: "fake-judge",
    async judge(c) {
      const requirements = c.ledger.requirements
        .filter((item) => c.phase.id === "finish" || item.phase === c.phase.id)
        .map((item) => ({
          id: item.id,
          status: verdict(item.text),
          probability: verdict(item.text) === "cleared" ? 0.9 : 0.3,
        }));
      return {
        cleared: requirements.every((item) => item.status === "cleared"),
        requirements,
        confidence: 0.9,
      };
    },
  };
}

describe("engine task contracts", () => {
  it("keeps the ledger serializable: create_task is not captured as evidence", async () => {
    const llm = agentLlm([
      response("", [createTask()]),
      response("", [{ id: "p1", name: "probe", arguments: "{}" }]),
      response("Refresh happens in session.ts."),
    ]);
    const result = await runAgent(
      userTurn("Investigate where auth is refreshed"),
      { llm, verifier: { allowWaived: true }, agent: testAgent },
    );
    expect(result.ledger).toBeDefined();
    expect(() => JSON.stringify(result.ledger)).not.toThrow();
    const tools = Object.values(result.ledger!.evidence).map((item) => item.tool);
    expect(tools).toContain("probe");
    expect(tools).not.toContain("create_task");
  });

  it("creates no ledger or gate when the agent does not call create_task", async () => {
    const result = await runAgent(
      userTurn("Hello"),
      {
        llm: agentLlm([response("Hello — what should I work on?")]),
        verifier: true,
        agent: testAgent,
      },
    );
    expect(result.summary).toContain("Hello");
    expect(result.ledger).toBeUndefined();
    expect(result.reason).toBe("finished");
  });

  it("creates the contract mid-run and exposes update_ledger next", async () => {
    const events: AgentEvent[] = [];
    const llm = agentLlm([
      response("", [createTask({ required: false })]),
      response("The refresh path is in src/auth/session.ts."),
    ]);
    const result = await runAgent(
      userTurn("Investigate where auth is refreshed"),
      {
        llm,
        verifier: true,
        agent: testAgent,
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.ledger?.requirements[0]).toMatchObject({
      text: "Find the refresh path",
      phase: "understand",
    });
    expect(events.some((event) => event.type === "task_created")).toBe(true);
    const second = llm.seen[1]!;
    expect(second.tools?.map((tool) => tool.function.name)).toContain(
      "update_ledger",
    );
    expect(JSON.stringify(second.messages)).toContain("Find the refresh path");
  });

  it("requires a claim to link evidence and supports verify in one call", async () => {
    const llm = agentLlm([
      response("", [createTask()]),
      response("", [
        { id: "c1", name: "probe", arguments: "{}" },
        {
          id: "c2",
          name: "update_ledger",
          arguments: JSON.stringify({
            op: "link_evidence",
            requirementId: "r1",
            evidenceId: "e1",
          }),
        },
      ]),
      response("", [
        {
          id: "c3",
          name: "update_ledger",
          arguments: JSON.stringify({
            op: "verify",
            requirementId: "r1",
            evidenceId: "e1",
            claim: "The probe found the refresh path.",
          }),
        },
      ]),
      response("Done."),
    ]);
    const result = await runAgent(
      userTurn("Investigate where auth is refreshed"),
      { llm, verifier: true, agent: testAgent },
    );

    const failed = result.messages.find(
      (message) =>
        message.role === "tool" &&
        message.content?.includes("claim is required"),
    );
    expect(failed).toBeDefined();
    expect(result.ledger?.requirements[0]).toMatchObject({
      status: "verified",
      evidenceIds: ["e1"],
    });
    expect(result.ledger?.evidence.e1?.claim).toContain("probe");
  });

  it("rejects a phase transition with an owned unmet requirement, naming it", async () => {
    const llm = agentLlm([
      response("", [createTask({ phase: "understand" })]),
      response("", [
        {
          id: "c1",
          name: "set_phase",
          arguments: JSON.stringify({ phase: "act", reason: "start acting" }),
        },
      ]),
      response("Still working."),
    ]);
    const result = await runAgent(
      userTurn("Investigate where auth is refreshed"),
      {
        llm,
        verifier: { judge: judge(() => "unproven") },
        agent: testAgent,
      },
    );
    expect(result.phase).toBe("understand");
    expect(
      llm.seen[2]?.messages.some((message) =>
        message.content?.includes("r1"),
      ),
    ).toBe(true);
  });

  it("does not call the judge when the outgoing phase owns no requirements", async () => {
    let calls = 0;
    const events: AgentEvent[] = [];
    const llm = agentLlm([
      response("", [createTask({ phase: "act" })]),
      response("", [
        {
          id: "c1",
          name: "set_phase",
          arguments: JSON.stringify({ phase: "act" }),
        },
      ]),
      response("Done."),
    ]);
    await runAgent(
      userTurn("Investigate where auth is refreshed"),
      {
        llm,
        verifier: {
          judge: {
            name: "counting",
            async judge(c) {
              calls += 1;
              return {
                cleared: true,
                requirements: c.ledger.requirements.map((item) => ({
                  id: item.id,
                  status: "cleared" as const,
                })),
                confidence: 1,
              };
            },
          },
        },
        agent: testAgent,
      },
    );
    expect(calls).toBe(0);
  });

  it("forces a phase transition after the rejection limit but keeps finish gated", async () => {
    let calls = 0;
    const events: AgentEvent[] = [];
    const llm = agentLlm([
      response("", [createTask({ phase: "understand" })]),
      response("", [
        {
          id: "c1",
          name: "set_phase",
          arguments: JSON.stringify({ phase: "act", reason: "attempt 1" }),
        },
      ]),
      response("", [
        {
          id: "c2",
          name: "set_phase",
          arguments: JSON.stringify({ phase: "act", reason: "attempt 2" }),
        },
      ]),
      response("", [
        {
          id: "c3",
          name: "set_phase",
          arguments: JSON.stringify({ phase: "act", reason: "attempt 3" }),
        },
      ]),
      response("Done."),
      response("Done."),
      response("Done."),
    ]);
    const result = await runAgent(
      userTurn("Investigate where auth is refreshed"),
      {
        llm,
        verifier: {
          maxRejectionsPerPhase: 2,
          judge: {
            name: "reject",
            async judge(c) {
              calls += 1;
              return {
                cleared: false,
                requirements: c.ledger.requirements.map((item) => ({
                  id: item.id,
                  status: "unproven" as const,
                  probability: 0.2,
                })),
                confidence: 0.2,
              };
            },
          },
        },
        agent: testAgent,
        onEvent: (event) => events.push(event),
      },
    );
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.phase).toBe("act");
    expect(result.ledger?.requirements[0]?.status).toBe("in_progress");
    expect(result.ok).toBe(false);
  });

  it("ends a finish({ success: false }) honestly with open failures", async () => {
    const llm = agentLlm([
      response("", [createTask()]),
      response("", [
        {
          id: "c1",
          name: "finish",
          arguments: JSON.stringify({
            summary: "Blocked on missing credentials.",
            success: false,
          }),
        },
      ]),
    ]);
    const result = await runAgent(
      userTurn("Investigate where auth is refreshed"),
      { llm, verifier: true, agent: testAgent },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("finished");
    expect(result.ledger?.openFailures.some((item) => item.includes("r1"))).toBe(
      true,
    );
  });

  it("does not attach a fully settled prior ledger", async () => {
    const store = new MemoryThreadStore();
    const prior = createLedger({ taskId: "old", source: "old request" });
    prior.requirements.push({
      id: "r1",
      text: "old requirement",
      required: true,
      status: "verified",
      evidenceIds: ["e1"],
      locked: true,
      origin: "user",
      revision: 1,
    });
    prior.evidence.e1 = {
      id: "e1",
      tool: "probe",
      ref: "call:old",
      ok: true,
      capturedAt: new Date().toISOString(),
    };
    await store.save("thread", { messages: [], ledger: prior });
    const llm = agentLlm([response("New conversation.")]);
    const result = await runAgent(
      userTurn("hello"),
      { llm, verifier: true, thread: { store, id: "thread" }, agent: testAgent },
    );
    expect(result.ledger).toBeUndefined();
    expect(result.reason).toBe("finished");
  });

  it("appends RunInput.messages to stored history without duplication", async () => {
    const store = new MemoryThreadStore();
    await store.save("thread", {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "first answer" },
      ],
    });
    const llm = agentLlm([response("second answer")]);
    const result = await runAgent(
      userTurn("second"),
      { llm, thread: { store, id: "thread" }, agent: testAgent },
    );
    const contents = result.messages.map((message) => message.content);
    expect(contents[0]).toContain("test agent");
    expect(contents.slice(1)).toEqual([
      "first",
      "first answer",
      "second",
      "second answer",
    ]);
    expect(contents.filter((item) => item === "first")).toHaveLength(1);
  });

  it("runs chat-shaped and task-shaped text with the same agent and tools", async () => {
    const chat = agentLlm([response("Hello.")]);
    const task = agentLlm([response("Working on it.")]);
    await runAgent(userTurn("Hello"), { llm: chat, agent: testAgent });
    await runAgent(userTurn("Implement Daytona support"), {
      llm: task,
      agent: testAgent,
    });
    expect(chat.seen[0]?.tools?.map((tool) => tool.function.name)).toEqual(
      task.seen[0]?.tools?.map((tool) => tool.function.name),
    );
    expect(chat.seen[0]?.tools?.map((tool) => tool.function.name)).toContain(
      "probe",
    );
  });
});

describe("renderInboxTurn integration", () => {
  it("claims one message per inbox row", async () => {
    const store = new MemoryInboxStore();
    await store.push({
      id: "1",
      channel: "t",
      text: "one",
      delivery: "queue",
    });
    await store.push({
      id: "2",
      channel: "t",
      text: "two",
      delivery: "queue",
    });
    const llm = agentLlm([response("ok")]);
    await runAgent(
      userTurn("start"),
      { llm, agent: testAgent, inbox: { store, channel: "t" } },
    );
    const last = llm.seen.at(-1)!;
    expect(last.messages.filter((m) => m.role === "user").at(-1)?.content).toBe(
      "two",
    );
  });
});
