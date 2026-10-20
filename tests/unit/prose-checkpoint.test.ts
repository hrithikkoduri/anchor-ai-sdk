import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "../../src/engine/events.js";
import { runAgent } from "../../src/engine/loop.js";
import { codingAgent } from "../../src/agents/coding/index.js";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import { scaffoldBuggyLib } from "../helpers/buggy-lib.js";
import { scripted } from "../helpers/scripted.js";

/**
 * #78 — a prose reply that answers an engine nudge is a checkpoint, not
 * automatically the result.
 *
 * The failure this guards against: after eight silent tool turns the
 * silent-tool nudge asks for "a reply or a visible status", the model writes
 * "I'm mid-fix", and the loop accepts that prose as the final answer with an
 * empty patch. Shape alone cannot tell a status report from a summary of
 * finished work.
 *
 * Scope matters: an ordinary prose ending after tool work is how most runs
 * finish, and gating it would add a call to every run. Only prose that answers
 * engine guidance is checked.
 */
describe("prose checkpoint", () => {
  let sandbox: LocalSandbox;
  let fixtureDir: string;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), "anchor-prose-"));
    await scaffoldBuggyLib(fixtureDir);
    sandbox = new LocalSandbox({ localPath: fixtureDir }, { quiet: true });
    await sandbox.start();
  });

  afterEach(async () => {
    await sandbox.destroy();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  const readTool = {
    name: "read_file",
    arguments: JSON.stringify({ path: "src/lib.js" }),
  };
  const finishTool = {
    name: "finish",
    arguments: JSON.stringify({ summary: "fixed", success: true }),
  };
  // One silent tool turn is enough to fire the nudge under test.
  const nudgeAtOne = { toolOnlyNudgeLimit: 1 };
  const checkpoints = (events: AgentEvent[]) =>
    events.filter(
      (e) => e.type === "advisory" && e.kind === "prose_checkpoint",
    );

  it("asks once instead of accepting a mid-work status report", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([
      { text: "", tools: [readTool] },
      { text: "Status: I reproduced the failure and I'm mid-fix." },
      { text: "Now fixed.", tools: [finishTool] },
    ]);
    const result = await runAgent(
      { task: "Fix the bug" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        guardrails: nudgeAtOne,
        onEvent: (e) => events.push(e),
      },
    );

    expect(checkpoints(events)).toHaveLength(1);
    // The gate only matters if it reaches the model on the next call.
    const third = llm.seen[2]!;
    expect(
      third.messages.some(
        (m) =>
          m.origin === "engine" && m.content?.includes("did not call `finish`"),
      ),
    ).toBe(true);
    // The model took the prompt and declared completion on its own terms.
    expect(result.completion).toBe("declared");
    expect(llm.seen).toHaveLength(3);
  });

  it("ends on a second prose turn, so the model can always insist it is done", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([
      { text: "", tools: [readTool] },
      { text: "Nothing needed changing." },
      { text: "Nothing needed changing." },
    ]);
    const result = await runAgent(
      { task: "Check the code" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        guardrails: nudgeAtOne,
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.completion).toBe("response");
    // One gate, not a loop: tool turn + two prose turns.
    expect(llm.seen).toHaveLength(3);
    expect(checkpoints(events)).toHaveLength(1);
  });

  it("leaves an ordinary prose ending alone", async () => {
    // No nudge fired, so the prose turn is the model's own decision to stop —
    // the normal finish path, and it must not cost an extra call.
    const events: AgentEvent[] = [];
    const llm = scripted([
      { text: "Looking.", tools: [readTool] },
      { text: "Here is what I found." },
    ]);
    const result = await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, onEvent: (e) => events.push(e) },
    );

    expect(result.completion).toBe("response");
    expect(llm.seen).toHaveLength(2);
    expect(checkpoints(events)).toHaveLength(0);
  });

  it("does not gate a run that never used a tool", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([{ text: "The answer is 42." }]);
    const result = await runAgent(
      { task: "What is the answer?" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        guardrails: nudgeAtOne,
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.completion).toBe("response");
    expect(llm.seen).toHaveLength(1);
    expect(checkpoints(events)).toHaveLength(0);
  });

  it("does not gate an agent with no declared-completion tool", async () => {
    // Without `finish`, prose is the only way out — so it must still be one,
    // even straight after a nudge.
    const events: AgentEvent[] = [];
    const llm = scripted([
      { text: "", tools: [readTool] },
      { text: "Here is what I found." },
    ]);
    const result = await runAgent(
      { task: "Explain the code" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        intrinsics: { finish: false },
        guardrails: nudgeAtOne,
        onEvent: (e) => events.push(e),
      },
    );

    expect([result.reason, result.completion]).toEqual([
      "finished",
      "response",
    ]);
    expect(llm.seen).toHaveLength(2);
    expect(checkpoints(events)).toHaveLength(0);
  });

  it("can be turned off", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([
      { text: "", tools: [readTool] },
      { text: "Status: mid-fix." },
    ]);
    const result = await runAgent(
      { task: "Fix the bug" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        guardrails: { ...nudgeAtOne, proseCheckpoint: false },
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.completion).toBe("response");
    expect(llm.seen).toHaveLength(2);
    expect(checkpoints(events)).toHaveLength(0);
  });

  it("stays out of the way when the model declares completion", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([
      { text: "", tools: [readTool] },
      { text: "Done.", tools: [finishTool] },
    ]);
    const result = await runAgent(
      { task: "Fix the bug" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        guardrails: nudgeAtOne,
        onEvent: (e) => events.push(e),
      },
    );

    expect(result.completion).toBe("declared");
    expect(checkpoints(events)).toHaveLength(0);
  });

  it("does not treat a capped reply as the prose checkpoint", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([
      { text: "", tools: [readTool] },
      { text: "cut off mid-reply", finishReason: "length" },
      { text: "cut off again", finishReason: "length" },
    ]);
    const result = await runAgent(
      { task: "Fix the bug" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        guardrails: nudgeAtOne,
        onEvent: (e) => events.push(e),
      },
    );

    // The cap has its own one-shot continue. It is not the nudge checkpoint,
    // and a second cap still stalls rather than becoming the answer.
    expect(result.reason).toBe("stalled");
    expect(checkpoints(events)).toHaveLength(0);
    expect(
      events.some((e) => e.type === "advisory" && e.kind === "output_cap_continue"),
    ).toBe(true);
  });
});
