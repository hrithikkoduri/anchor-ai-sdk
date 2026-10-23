import { describe, expect, it } from "vitest";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import { MemoryInboxStore } from "../../src/engine/inbox.js";
import {
  addRequirement,
  createLedger,
  setRequirementStatus,
} from "../../src/ledger/index.js";
import { runAgent } from "../../src/engine/loop.js";
import { defineTool } from "../../src/tools/types.js";
import type { Agent } from "../../src/agents/types.js";

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

function agentLlm(
  sequence: LLMResponse[],
  onStream?: (callNumber: number) => void | Promise<void>,
): LLMClient & { seen: LLMRequest[] } {
  let index = 0;
  let streamCalls = 0;
  const seen: LLMRequest[] = [];
  const next = (req: LLMRequest) => {
    if (
      req.responseFormat?.type === "json_schema" &&
      req.responseFormat.name === "ledger_contract"
    ) {
      return response(
        JSON.stringify({
          goal: "Explain where auth is refreshed.",
          requirements: [{ text: "Find the refresh path", required: true }],
        }),
      );
    }
    if (
      req.responseFormat?.type === "json_schema" &&
      req.responseFormat.name === "compaction_handoff"
    ) {
      return response(
        JSON.stringify({
          task: "Fix the retry bug",
          requirements: [
            {
              id: "r1",
              text: "Patch the deadline",
              status: "open",
              evidence: [],
            },
          ],
          completed: ["Read the retry path"],
          currentState: "The deadline patch is still open.",
          openFailures: [],
          nextSteps: ["Patch the deadline"],
          constraints: ["Do not claim completion without evidence"],
          lastObservations: ["The retry resets the deadline"],
          git: { checkpoint: "abc123" },
        }),
      );
    }
    if (
      req.responseFormat?.type === "json_schema" &&
      req.responseFormat.name === "phase_alignment"
    ) {
      return response(
        JSON.stringify({
          allow: true,
          aligned: true,
          justified: true,
          reason: "evidence matches the ledger",
          requiredAction: "none",
          confidence: 0.9,
        }),
      );
    }
    const item = sequence[index];
    if (!item) throw new Error(`unexpected model call ${index + 1}`);
    index += 1;
    return item;
  };
  return {
    model: "fake",
    seen,
    complete: async (req) => {
      seen.push(structuredClone(req));
      return next(req);
    },
    stream: async (req, onDelta) => {
      seen.push(structuredClone(req));
      streamCalls += 1;
      await onStream?.(streamCalls);
      const out = next(req);
      onDelta(out.text);
      return out;
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
    phases: [{ id: "act", goal: "do the requested work" }],
    systemPrompt: () => "test agent",
  },
  tools: [probe],
};

describe("engine verifier integration", () => {
  it("creates no ledger for a greeting", async () => {
    const store = new MemoryThreadStore();
    const result = await runAgent(
      { task: "Hi" },
      {
        llm: agentLlm([response("Hello — what should I work on?")]),
        verifier: true,
        thread: { store, id: "chat-1" },
      },
    );

    expect(result.summary).toContain("Hello");
    expect((await store.load("chat-1"))?.ledger).toBeUndefined();
  });

  it("compiles a ledger, links evidence, and verifies a task finish", async () => {
    const store = new MemoryThreadStore();
    const llm = agentLlm([
      response("", [
        {
          id: "c1",
          name: "probe",
          arguments: "{}",
        },
      ]),
      response("", [
        {
          id: "c2",
          name: "update_ledger",
          arguments: JSON.stringify({
            op: "link_evidence",
            requirementId: "r1",
            evidenceId: "e1",
          }),
        },
        {
          id: "c3",
          name: "update_ledger",
          arguments: JSON.stringify({
            op: "set_status",
            requirementId: "r1",
            status: "verified",
          }),
        },
      ]),
      response("Auth is refreshed in src/auth/session.ts:42."),
    ]);

    const result = await runAgent(
      { task: "Investigate where auth is refreshed" },
      {
        llm,
        verifier: true,
        agent: testAgent,
        thread: { store, id: "task-1" },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.ledger?.requirements[0]).toMatchObject({
      id: "r1",
      status: "verified",
      evidenceIds: ["e1"],
    });
    const saved = await store.load("task-1");
    expect(saved?.ledger?.requirements[0]?.status).toBe("verified");
  });

  it("blocks a finish with no evidence and does not report success", async () => {
    const store = new MemoryThreadStore();
    const llm = agentLlm([
      response("Done."),
      response("Done."),
      response("Done."),
    ]);

    const result = await runAgent(
      { task: "Investigate where auth is refreshed" },
      {
        llm,
        verifier: true,
        agent: testAgent,
        thread: { store, id: "task-2" },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("stalled");
    expect(result.ledger?.requirements[0]?.status).toBe("open");
  });

  it("preserves an existing ledger across a chat turn", async () => {
    const store = new MemoryThreadStore();
    await store.save("chat-2", {
      messages: [],
      ledger: {
        version: 1,
        taskId: "t1",
        revision: 1,
        source: { kind: "user", text: "task" },
        goal: "task",
        requirements: [],
        evidence: {},
        openFailures: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await runAgent(
      { task: "Hi" },
      {
        llm: agentLlm([response("Hello.")]),
        verifier: true,
        thread: { store, id: "chat-2" },
      },
    );

    expect((await store.load("chat-2"))?.ledger?.taskId).toBe("t1");
  });
  it("routes auto follow-ups to the task path while a required ledger item is open", async () => {
    for (const followUp of ["continue", "where is the PR?"]) {
      const store = new MemoryThreadStore();
      const ledger = createLedger({ taskId: "t", source: "Fix the retry bug" });
      addRequirement(ledger, { text: "Patch the deadline" });
      await store.save("thread", { messages: [], ledger });
      const llm = agentLlm([response("Still working.")]);

      const result = await runAgent(
        { task: followUp },
        {
          llm,
          verifier: true,
          agent: testAgent,
          thread: { store, id: "thread" },
        },
      );

      const tools = llm.seen[0]?.tools?.map((tool) => tool.function.name) ?? [];
      expect(tools).toContain("probe");
      expect(tools).toContain("update_ledger");
      expect(JSON.stringify(llm.seen[0]?.messages)).toContain(
        "Patch the deadline",
      );
      expect(result.ledger?.requirements[0]?.status).toBe("open");
    }
  });

  it("keeps the finish gate enforced after ledger-aware routing", async () => {
    const store = new MemoryThreadStore();
    const ledger = createLedger({ taskId: "t", source: "Fix the retry bug" });
    addRequirement(ledger, { text: "Patch the deadline" });
    await store.save("thread", { messages: [], ledger });
    const llm = agentLlm([
      response("", [
        {
          id: "f1",
          name: "finish",
          arguments: JSON.stringify({ summary: "Done.", success: true }),
        },
      ]),
      response("The gate rejected that finish."),
    ]);

    await runAgent(
      { task: "continue" },
      {
        llm,
        verifier: { gates: [] },
        agent: testAgent,
        thread: { store, id: "thread" },
      },
    );

    expect(
      llm.seen[1]?.messages.some((message) =>
        message.content?.includes(
          "Verification gate: required work is not complete.",
        ),
      ),
    ).toBe(true);
  });

  it("honors explicit task routing", async () => {
    const llm = agentLlm([response("Still working.")]);
    await runAgent(
      { task: "continue" },
      { llm, verifier: true, intent: "task", agent: testAgent },
    );
    const taskRequest = llm.seen.find((request) =>
      request.tools?.some((tool) => tool.function.name === "probe"),
    );
    const tools = taskRequest?.tools?.map((tool) => tool.function.name) ?? [];
    expect(tools).toContain("probe");
    expect(tools).toContain("update_ledger");
  });

  it("resets a task window with a structured handoff and keeps the recent tail", async () => {
    const store = new MemoryThreadStore();
    const ledger = createLedger({ taskId: "t", source: "Fix the retry bug" });
    addRequirement(ledger, { text: "Patch the deadline" });
    await store.save("thread", {
      messages: [
        { role: "user", content: "old request" },
        { role: "assistant", content: "x".repeat(20_000) },
        { role: "user", content: "recent context" },
        {
          role: "assistant",
          content: "recent context ".repeat(80),
        },
      ],
      ledger,
    });
    const llm = agentLlm([
      response("After the reset."),
      response("Done."),
      response("Done."),
    ]);

    const result = await runAgent(
      { task: "continue" },
      {
        llm,
        verifier: true,
        agent: testAgent,
        thread: { store, id: "thread" },
        compaction: { maxEstimatedTokens: 3_000, keepRecentTokens: 20 },
      },
    );

    expect(result.compaction).toMatchObject({
      task: "Fix the retry bug",
      currentState: "The deadline patch is still open.",
    });
    const after = llm.seen.find((request) =>
      request.tools?.some((tool) => tool.function.name === "probe"),
    );
    const text = JSON.stringify(after?.messages);
    expect(text).toContain("Durable task handoff");
    expect(text).toContain("Patch the deadline");
    expect(text).toContain("recent context");
    expect(text).not.toContain("x".repeat(20_000));
    expect(result.steps).toBeGreaterThan(0);
    expect((await store.load("thread"))?.compaction?.task).toBe(
      "Fix the retry bug",
    );
  });

  it("honors explicit chat even when a required ledger item is open", async () => {
    const store = new MemoryThreadStore();
    const ledger = createLedger({ taskId: "t", source: "Fix the retry bug" });
    addRequirement(ledger, { text: "Patch the deadline" });
    await store.save("thread", { messages: [], ledger });
    const llm = agentLlm([response("Hello.")]);

    const result = await runAgent(
      { task: "continue" },
      {
        llm,
        verifier: true,
        intent: "chat",
        agent: testAgent,
        thread: { store, id: "thread" },
      },
    );

    const tools = llm.seen[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(tools).not.toContain("probe");
    expect(tools).not.toContain("update_ledger");
    expect(result.ledger).toBeUndefined();
  });

  it("does not force task routing for a completed ledger", async () => {
    const store = new MemoryThreadStore();
    const ledger = createLedger({ taskId: "t", source: "Fix the retry bug" });
    addRequirement(ledger, { text: "Patch the deadline" });
    setRequirementStatus(ledger, "r1", "verified");
    await store.save("thread", { messages: [], ledger });
    const llm = agentLlm([response("Nothing outstanding.")]);

    await runAgent(
      { task: "continue" },
      {
        llm,
        verifier: true,
        agent: testAgent,
        thread: { store, id: "thread" },
      },
    );

    const tools = llm.seen[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(tools).not.toContain("probe");
    expect(tools).not.toContain("update_ledger");
  });

  it("re-routes an inbox follow-up from the ledger, not the first run's route", async () => {
    const store = new MemoryInboxStore();
    const thread = new MemoryThreadStore();
    let pushed = false;
    const llm = agentLlm(
      [
        response("First run still has work."),
        response("Continuing the task."),
        response("Follow-up complete."),
      ],
      async (callNumber) => {
        if (callNumber === 1 && !pushed) {
          pushed = true;
          await store.push({
            id: "follow-up",
            channel: "thread",
            text: "continue",
            delivery: "queue",
          });
        }
      },
    );

    const result = await runAgent(
      { task: "Investigate where auth is refreshed" },
      {
        llm,
        verifier: { gates: [] },
        agent: testAgent,
        inbox: { store, channel: "thread" },
        thread: { store: thread, id: "thread" },
      },
    );

    expect(result.runs).toHaveLength(2);
    const followUp = llm.seen.find((request) =>
      request.messages.some((message) => message.content === "continue"),
    );
    const tools = followUp?.tools?.map((tool) => tool.function.name) ?? [];
    expect(tools).toContain("probe");
    expect(tools).toContain("update_ledger");
    expect(JSON.stringify(followUp?.messages)).toContain("Find the refresh path");
  });

});
