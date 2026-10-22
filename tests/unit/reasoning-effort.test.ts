import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import type { AgentStrategy } from "../../src/engine/strategy.js";
import type { Agent } from "../../src/agents/types.js";
import { scripted } from "../helpers/scripted.js";

const strategy: AgentStrategy = {
  name: "test",
  phases: [{ id: "work", goal: "do the work" }],
  systemPrompt: () => "You are a test agent.",
};

describe("reasoning effort", () => {
  it("travels from EngineOptions to the model request", async () => {
    const llm = scripted([{ text: "done" }]);
    await runAgent(
      { task: "say done" },
      { llm, strategy, reasoningEffort: "high" },
    );
    expect(llm.seen[0]?.reasoningEffort).toBe("high");
  });

  it("uses the agent bundle's default and lets the explicit option win", async () => {
    const agent: Agent = {
      name: "test",
      strategy,
      tools: [],
      reasoningEffort: "low",
    };
    const fromBundle = scripted([{ text: "done" }]);
    await runAgent({ task: "say done" }, { llm: fromBundle, agent });
    expect(fromBundle.seen[0]?.reasoningEffort).toBe("low");

    const overridden = scripted([{ text: "done" }]);
    await runAgent(
      { task: "say done" },
      { llm: overridden, agent, reasoningEffort: "xhigh" },
    );
    expect(overridden.seen[0]?.reasoningEffort).toBe("xhigh");
  });
});
