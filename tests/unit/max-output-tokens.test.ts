import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../../src/engine/budgets.js";
import type { AgentEvent } from "../../src/engine/events.js";
import { runAgent } from "../../src/engine/loop.js";
import { createCodingAgent, codingAgent } from "../../src/agents/coding/index.js";
import { chatAgent } from "../../src/agents/chat/index.js";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import { scaffoldBuggyLib } from "../helpers/buggy-lib.js";
import { scripted } from "../helpers/scripted.js";

/** The per-call output cap: bounded by default, overridable, and loud when hit. */
describe("max output tokens", () => {
  let sandbox: LocalSandbox;
  let fixtureDir: string;
  beforeEach(async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), "anchor-captok-"));
    await scaffoldBuggyLib(fixtureDir);
    sandbox = new LocalSandbox({ localPath: fixtureDir }, { quiet: true });
    await sandbox.start();
  });
  afterEach(async () => {
    await sandbox.destroy();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  const ok = (text = "No changes.") => [{ text }];

  it("sends the 12k default on every call", async () => {
    const llm = scripted(ok());
    await runAgent({ task: "Explain the code" }, { llm, sandbox, agent: codingAgent });
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(12_000);
    expect(llm.seen[0]!.maxTokens).toBe(12_000);
  });

  it("applies the same default to a non-coding agent", async () => {
    const llm = scripted(ok("Understood."));
    await runAgent({ task: "Say hi" }, { llm, agent: chatAgent });
    expect(llm.seen[0]!.maxTokens).toBe(12_000);
  });

  it("lets an explicit engine option win over the agent's suggestion", async () => {
    const llm = scripted(ok());
    await runAgent(
      { task: "Explain the code" },
      {
        llm,
        sandbox,
        agent: createCodingAgent({ maxOutputTokens: 4_000 }),
        maxOutputTokens: 9_000,
      },
    );
    expect(llm.seen[0]!.maxTokens).toBe(9_000);
  });

  it("honours the coding agent's own setting", async () => {
    const llm = scripted(ok());
    await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: createCodingAgent({ maxOutputTokens: 4_000 }) },
    );
    expect(llm.seen[0]!.maxTokens).toBe(4_000);
  });

  it("leaves output unbounded when the cap is false", async () => {
    const llm = scripted(ok());
    await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, maxOutputTokens: false },
    );
    expect(llm.seen[0]!.maxTokens).toBeUndefined();
  });

  it("reports a capped response instead of swallowing it", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([{ text: "I was halfway through expl", finishReason: "length" }]);
    const result = await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, maxOutputTokens: 1_000, onEvent: (e) => events.push(e) },
    );
    const advisory = events.find(
      (e): e is Extract<AgentEvent, { type: "advisory" }> =>
        e.type === "advisory" && e.kind === "output_truncated",
    );
    expect(advisory).toBeDefined();
    expect(advisory!.detail).toContain("1000-token output cap");
    expect(advisory!.detail).toContain("incomplete");
    // The important half: a cut-off reply is never published as the answer.
    expect(result.ok).toBe(false);
    expect(result.completion).not.toBe("response");
    expect(result.reason).toBe("stalled");
  });

  it("accepts a truncated turn that still delivered its tool call", async () => {
    // Tool calls arrive at the end of a message, so a cap that lands first
    // swallows them. When the call did arrive, the turn is usable.
    const llm = scripted([
      { text: "Reading the file no", finishReason: "length", tools: [
        { name: "read_file", arguments: JSON.stringify({ path: "src/lib.js" }) },
      ] },
      { text: "Done." },
    ]);
    const result = await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, maxOutputTokens: 1_000 },
    );
    expect(result.steps).toBe(2);
    expect(result.completion).toBe("response");
  });

  it("stays quiet when the response ended on its own", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([{ text: "Done.", finishReason: "stop" }]);
    await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, onEvent: (e) => events.push(e) },
    );
    expect(
      events.some((e) => e.type === "advisory" && e.kind === "output_truncated"),
    ).toBe(false);
  });

  it("rejects a non-positive threshold instead of guessing (false is the switch)", async () => {
    // 0 must not silently mean "uncapped" here while meaning "immediately"
    // for a nudge. Every `number | false` dial fails fast on a bad number.
    const bad = [
      { maxOutputTokens: 0 },
      { maxAssistantChars: 0 },
      { truncatedReplyChars: -1 },
      { guardrails: { verboseTurnLimit: 0 } },
      { guardrails: { toolOnlyNudgeLimit: 0 } },
      { guardrails: { repeatedToolCallLimit: 0 } },
    ] as const;
    for (const opts of bad) {
      await expect(
        runAgent(
          { task: "Explain the code" },
          { llm: scripted(ok()), sandbox, agent: codingAgent, ...opts },
        ),
      ).rejects.toThrow(/must be a positive number or false/);
    }
    // The switch still works.
    const llm = scripted(ok());
    await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, maxOutputTokens: false },
    );
    expect(llm.seen[0]!.maxTokens).toBeUndefined();
  });
});
