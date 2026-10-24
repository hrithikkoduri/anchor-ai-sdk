import { describe, expect, it } from "vitest";
import { chatAgent } from "../../src/agents/chat/index.js";
import { runAgent } from "../../src/engine/loop.js";
import { userTurn } from "../../src/engine/types.js";
import { defineTool, type Tool } from "../../src/tools/types.js";
import { scripted } from "../helpers/scripted.js";
import type { Agent } from "../../src/agents/types.js";
import type { AgentEvent } from "../../src/engine/events.js";

const readTool = defineTool(
  {
    name: "read_probe",
    description: "read-only test tool",
    parameters: { type: "object", properties: {} },
  },
  async () => ({ ok: true, content: "read result" }),
  { readOnly: true },
);

const writeTool = defineTool(
  {
    name: "write_probe",
    description: "mutating test tool",
    parameters: { type: "object", properties: {} },
  },
  async () => ({ ok: true, content: "write result" }),
);

function agent(name: string, tools: Tool[]): Agent {
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

function delegateCall(agentName: string, task = "review it") {
  return {
    tools: [
      {
        name: "delegate",
        arguments: JSON.stringify({ agent: agentName, task }),
      },
    ],
  };
}

describe("delegated subagents", () => {
  it("runs a named evaluator read-only and returns only its result", async () => {
    const events: AgentEvent[] = [];
    const parent = scripted([delegateCall("reviewer"), { text: "lead done" }]);
    const child = scripted([
      { tools: [{ name: "write_probe", arguments: "{}" }] },
      { text: "review complete" },
    ]);
    const leader = agent("leader", []);
    const reviewer = agent("reviewer", [readTool, writeTool]);

    const result = await runAgent(userTurn("delegate the review"), {
      llm: parent,
      agent: leader,
      team: {
        members: {
          reviewer: { agent: reviewer, role: "evaluator", llm: child },
        },
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    const toolResults = result.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content);
    expect(toolResults).toContain("review complete");
    expect(toolResults.join("\n")).not.toContain("write result");

    const writeResult = events.find(
      (event) =>
        event.type === "tool_result" &&
        event.agent === "reviewer" &&
        event.name === "write_probe",
    );
    expect(writeResult).toMatchObject({ ok: false });
    expect(
      events.some(
        (event) =>
          event.agent === "reviewer" &&
          event.parentAgent === "leader" &&
          typeof event.delegateCallId === "string",
      ),
    ).toBe(true);
  });

  it("allows a worker to mutate and reports its result", async () => {
    const events: AgentEvent[] = [];
    const parent = scripted([delegateCall("implementer"), { text: "lead done" }]);
    const child = scripted([
      { tools: [{ name: "write_probe", arguments: "{}" }] },
      { text: "implemented" },
    ]);
    const result = await runAgent(userTurn("delegate the fix"), {
      llm: parent,
      agent: agent("leader", []),
      team: {
        members: {
          implementer: {
            agent: agent("implementer", [writeTool]),
            role: "worker",
            llm: child,
          },
        },
      },
      onEvent: (event) => events.push(event),
    });
    expect(result.ok).toBe(true);
    expect(
      events.find(
        (event) =>
          event.type === "tool_result" &&
          event.agent === "implementer" &&
          event.name === "write_probe",
      ),
    ).toMatchObject({ ok: true });
    expect(
      result.messages.some((message) => message.content === "implemented"),
    ).toBe(true);
  });

  it("fails cleanly for an unknown team member", async () => {
    const parent = scripted([delegateCall("missing"), { text: "lead done" }]);
    const result = await runAgent(userTurn("delegate"), {
      llm: parent,
      agent: agent("leader", []),
      team: {
        members: {
          reviewer: {
            agent: agent("reviewer", [readTool]),
            role: "evaluator",
            llm: scripted([{ text: "unused" }]),
          },
        },
      },
    });
    expect(
      result.messages.some((message) =>
        message.content?.includes('unknown team member "missing"'),
      ),
    ).toBe(true);
  });

  it("does not expose delegate without a team", async () => {
    const parent = scripted([delegateCall("reviewer"), { text: "lead done" }]);
    const result = await runAgent(userTurn("delegate"), {
      llm: parent,
      agent: agent("leader", []),
    });
    expect(
      result.messages.some((message) =>
        message.content?.includes('unknown tool "delegate"'),
      ),
    ).toBe(true);
  });
});
