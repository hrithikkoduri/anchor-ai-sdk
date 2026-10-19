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

/** The mirror of the silent-tool nudge: one advisory when a turn writes too much. */
describe("verbose turn nudge", () => {
  let sandbox: LocalSandbox;
  let fixtureDir: string;
  beforeEach(async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), "anchor-verbose-"));
    await scaffoldBuggyLib(fixtureDir);
    sandbox = new LocalSandbox({ localPath: fixtureDir }, { quiet: true });
    await sandbox.start();
  });
  afterEach(async () => {
    await sandbox.destroy();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  const big = { promptTokens: 100, completionTokens: 9_000, totalTokens: 9_100 };
  const small = { promptTokens: 100, completionTokens: 200, totalTokens: 300 };
  const atLimit = { promptTokens: 100, completionTokens: 8_000, totalTokens: 8_100 };
  const readTool = {
    name: "read_file",
    arguments: JSON.stringify({ path: "src/lib.js" }),
  };

  it("nudges once when a turn overshoots, and the model sees it", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([
      { text: "Let me think about this at length...", tools: [readTool], usage: big },
      { text: "Done.", usage: small },
    ]);
    const result = await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, onEvent: (e) => events.push(e) },
    );
    const nudges = events.filter(
      (e) => e.type === "advisory" && e.kind === "verbose_turn",
    );
    expect(nudges).toHaveLength(1);
    // The nudge only matters if it reaches the model: it must ride the next call.
    const second = llm.seen[1]!;
    const advisory = second.messages.find(
      (m) => m.origin === "engine" && m.content?.includes("Stop deliberating in prose"),
    );
    expect(advisory).toBeDefined();
    expect(advisory!.content).toContain("9000 tokens of output");
    expect(result.completion).toBe("response");
  });

  it("fires at most once in a run", async () => {
    // Three oversized turns: the model has been told; after that the output
    // cap is the backstop, and repeating the nudge is just more context.
    const llm = scripted([
      { text: "rambling one", tools: [readTool], usage: big },
      { text: "rambling two", tools: [readTool], usage: big },
      { text: "Done.", usage: small },
    ]);
    const events: AgentEvent[] = [];
    await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, onEvent: (e) => events.push(e) },
    );
    expect(
      events.filter((e) => e.type === "advisory" && e.kind === "verbose_turn"),
    ).toHaveLength(1);
  });

  it("stays quiet under the limit", async () => {
    const llm = scripted([
      { text: "Reading.", tools: [readTool], usage: small },
      { text: "Done.", usage: small },
    ]);
    const events: AgentEvent[] = [];
    await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, onEvent: (e) => events.push(e) },
    );
    expect(
      events.some((e) => e.type === "advisory" && e.kind === "verbose_turn"),
    ).toBe(false);
  });

  it("can be turned off", async () => {
    const llm = scripted([
      { text: "rambling", tools: [readTool], usage: big },
      { text: "Done.", usage: small },
    ]);
    const events: AgentEvent[] = [];
    await runAgent(
      { task: "Explain the code" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        guardrails: { verboseTurnLimit: false },
        onEvent: (e) => events.push(e),
      },
    );
    expect(
      events.some((e) => e.type === "advisory" && e.kind === "verbose_turn"),
    ).toBe(false);
  });

  it("honours a caller-set limit", async () => {
    const llm = scripted([
      { text: "chatty", tools: [readTool], usage: small },
      { text: "Done.", usage: small },
    ]);
    const events: AgentEvent[] = [];
    await runAgent(
      { task: "Explain the code" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        guardrails: { verboseTurnLimit: 100 },
        onEvent: (e) => events.push(e),
      },
    );
    expect(
      events.filter((e) => e.type === "advisory" && e.kind === "verbose_turn"),
    ).toHaveLength(1);
  });

  it("fires strictly above the 8k default, not at it", async () => {
    // The limit is a floor on tolerance: a turn that lands exactly on it has
    // not overshot, and the cap (12k) is what bounds it.
    const llm = scripted([
      { text: "exactly at the limit", tools: [readTool], usage: atLimit },
      { text: "Done.", usage: small },
    ]);
    const events: AgentEvent[] = [];
    await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, onEvent: (e) => events.push(e) },
    );
    expect(
      events.some((e) => e.type === "advisory" && e.kind === "verbose_turn"),
    ).toBe(false);
  });
});
