import { describe, expect, it } from "vitest";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
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

function agentLlm(sequence: LLMResponse[]): LLMClient {
  let index = 0;
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
    complete: async (req) => next(req),
    stream: async (req, onDelta) => {
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
});
