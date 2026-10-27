import { describe, expect, it } from "vitest";
import { agentLlm, createTask, response, runAgent, testAgent, userTurn } from "../helpers/agent-kit.js";

/** The focused tools, named by the model, each with only the field its job needs. */
describe("the task contract, one tool per operation", () => {
  it("offers a tool per operation, and no op field on them", async () => {
    const llm = agentLlm([response("", [createTask()]), response("Done.")]);
    await runAgent(userTurn("Investigate where auth is refreshed"), { llm, verifier: true, agent: testAgent });
    const tools = llm.seen[1]!.tools!.map((t) => t.function.name);
    for (const name of ["add_requirement", "set_requirement_status", "link_evidence", "verify_requirement", "set_next_step", "add_failure", "clear_failure"]) {
      expect(tools, name).toContain(name);
    }
    const add = llm.seen[1]!.tools!.find((t) => t.function.name === "add_requirement")!;
    const props = (add.function.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).not.toContain("op");
    expect(Object.keys(props)).not.toContain("status");
    expect(Object.keys(props)).not.toContain("failure");
  });

  it("adds, then marks status and records a failure, by their own tools", async () => {
    const llm = agentLlm([
      response("", [createTask()]),
      response("", [{ id: "a1", name: "add_requirement", arguments: JSON.stringify({ text: "Annotations render on the chart" }) }]),
      response("", [{ id: "a2", name: "set_requirement_status", arguments: JSON.stringify({ requirementId: "r2", status: "in_progress" }) }]),
      response("", [{ id: "a3", name: "add_failure", arguments: JSON.stringify({ failure: "The chart mounts before data" }) }]),
      response("", [{ id: "a4", name: "add_requirement", arguments: JSON.stringify({ text: "A second one" }) }]),
      response("", [{ id: "a5", name: "set_requirement_status", arguments: JSON.stringify({ requirementId: "r3", status: "open" }) }]),
      response("Done."),
    ]);
    const result = await runAgent(userTurn("Add notes to the chart"), { llm, verifier: true, agent: testAgent });
    const byText = new Map(result.ledger?.requirements.map((r) => [r.text, r]));
    expect(byText.get("Annotations render on the chart")?.status).toBe("in_progress");
    expect(byText.get("A second one")?.status).toBe("open");
    expect(result.ledger?.openFailures).toContain("The chart mounts before data");
    // Ledger tools describe the contract; they are not evidence about the work.
    expect(Object.keys(result.ledger?.evidence ?? {})).toHaveLength(0);
  });

  it("rejects an add without text before it reaches the ledger, so nothing is retried", async () => {
    const llm = agentLlm([
      response("", [createTask()]),
      response("", [{ id: "a1", name: "add_requirement", arguments: JSON.stringify({ dependsOn: ["r1"] }) }]),
      response("Done."),
    ]);
    const result = await runAgent(userTurn("Add notes to the chart"), { llm, verifier: true, agent: testAgent });
    // Only create_task's requirement is there: the malformed add did nothing.
    expect(result.ledger?.requirements.length).toBe(1);
  });
});
