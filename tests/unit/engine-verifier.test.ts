import { describe, expect, it } from "vitest";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import { MemoryInboxStore } from "../../src/engine/inbox.js";
import {
  createLedger,
  setRequirementStatus,
} from "../../src/ledger/index.js";
import { runAgent, userTurn } from "../../src/engine/loop.js";
import type { AgentEvent } from "../../src/engine/events.js";
import type { Judge } from "../../src/verify/index.js";
import {
  agentLlm,
  createTask,
  response,
  testAgent,
} from "../helpers/agent-kit.js";

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

  it("rejects an invalid dependency graph from create_task", async () => {
    const llm = agentLlm([
      response("", [
        {
          id: "create-cycle",
          name: "create_task",
          arguments: JSON.stringify({
            goal: "Create a bad graph",
            requirements: [
              {
                id: "a",
                text: "A",
                phase: "understand",
                dependsOn: ["b"],
              },
              {
                id: "b",
                text: "B",
                phase: "act",
                dependsOn: ["a"],
              },
            ],
          }),
        },
      ]),
      response("I could not create that contract."),
    ]);
    const result = await runAgent(
      userTurn("Create a bad graph"),
      { llm, verifier: true, agent: testAgent },
    );
    expect(result.ledger).toBeUndefined();
    expect(
      result.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content?.includes("requirement dependency cycle"),
      ),
    ).toBe(true);
  });

  it("rejects verify when a dependency is still open", async () => {
    const llm = agentLlm([
      response("", [
        {
          id: "create-graph",
          name: "create_task",
          arguments: JSON.stringify({
            goal: "Do ordered work",
            requirements: [
              {
                id: "base",
                text: "Base work",
                phase: "understand",
                required: false,
              },
              {
                id: "top",
                text: "Dependent work",
                phase: "act",
                required: false,
                dependsOn: ["base"],
              },
            ],
          }),
        },
      ]),
      response("", [{ id: "p1", name: "probe", arguments: "{}" }]),
      response("", [
        {
          id: "v1",
          name: "update_ledger",
          arguments: JSON.stringify({
            op: "verify",
            requirementId: "top",
            evidenceId: "e1",
            claim: "The probe proves the dependent work.",
          }),
        },
      ]),
      response("Done."),
    ]);
    const result = await runAgent(
      userTurn("Do ordered work"),
      { llm, verifier: true, agent: testAgent },
    );

    expect(
      result.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content?.includes("top requires base"),
      ),
    ).toBe(true);
    expect(
      result.ledger?.requirements.find((item) => item.id === "top"),
    ).toMatchObject({ status: "open", evidenceIds: [] });
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

  it("tells the model what add_requirement needs, so a missing text is fixed rather than retried", async () => {
    const llm = agentLlm([
      response("", [createTask({ required: false })]),
      response("", [
        {
          id: "a1",
          name: "update_ledger",
          arguments: JSON.stringify({ op: "add_requirement", dependsOn: ["r1"] }),
        },
      ]),
      response("", [
        {
          id: "a2",
          name: "update_ledger",
          arguments: JSON.stringify({ op: "add_requirement", text: "Threads can be filtered by label", dependsOn: ["r1"] }),
        },
      ]),
      response("Done."),
    ]);
    const result = await runAgent(
      userTurn("Investigate where auth is refreshed"),
      { llm, verifier: true, agent: testAgent },
    );

    // Adding is its own tool, and its one required field is the text: a call
    // without it never reaches the ledger, so there is nothing to retry.
    const tool = llm.seen[1]!.tools!.find((t) => t.function.name === "add_requirement")!;
    expect(tool).toBeTruthy();
    const params = tool.function.parameters as { required: string[] };
    expect(params.required).toEqual(["text"]);
    expect(result.ledger?.requirements.map((r) => r.text)).toContain("Threads can be filtered by label");
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

  it("keeps a settled ledger when offered for extension, and grows it with follow-up work", async () => {
    const prior = createLedger({ taskId: "old", source: "old request" });
    prior.requirements.push({
      id: "r1", text: "old requirement", required: true, status: "verified", evidenceIds: ["e1"], locked: true, origin: "user", revision: 1,
    });
    prior.evidence.e1 = { id: "e1", tool: "probe", ref: "call:old", ok: true, capturedAt: new Date().toISOString() };
    const llm = agentLlm([
      response("", [{ id: "a1", name: "update_ledger", arguments: JSON.stringify({ op: "add_requirement", text: "Verify it against the live stack" }) }]),
      response("Added."),
    ]);
    const result = await runAgent(userTurn("check it works live"), { llm, verifier: true, agent: testAgent, ledger: prior, extendLedger: true });
    expect(llm.seen[0]!.tools!.some((t) => t.function.name === "update_ledger")).toBe(true);
    expect(result.ledger?.requirements.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(result.ledger?.requirements[0]!.status).toBe("verified");
  });

  it("infers update_ledger's op from its fields, when they name exactly one", async () => {
    const llm = agentLlm([
      response("", [createTask()]),
      response("", [{ id: "s1", name: "update_ledger", arguments: JSON.stringify({ requirementId: "r1", status: "blocked" }) }]),
      response("", [{ id: "s2", name: "update_ledger", arguments: JSON.stringify({ text: "hmm" }) }]),
      response("Done."),
    ]);
    const result = await runAgent(userTurn("Investigate where auth is refreshed"), { llm, verifier: true, agent: testAgent });
    expect(result.ledger?.requirements[0]!.status).toBe("blocked");
    // Ambiguous (a next step, or a requirement?): asked, with examples to copy.
    const asked = result.messages.find((m) => m.role === "tool" && m.content?.includes("Say which op"));
    expect(asked?.content).toContain("Say which op");
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
