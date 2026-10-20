import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "../../src/engine/events.js";
import { runAgent } from "../../src/engine/loop.js";
import {
  DEFAULT_TRUNCATED_REPLY_CHARS,
  DEFAULT_MAX_ASSISTANT_CHARS,
  elideReply,
} from "../../src/engine/elision.js";
import { codingAgent } from "../../src/agents/coding/index.js";
import { chatAgent } from "../../src/agents/chat/index.js";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import { scaffoldBuggyLib } from "../helpers/buggy-lib.js";
import { scripted } from "../helpers/scripted.js";

/**
 * Assistant-text elision (#77). The transcript stays whole; the model's view
 * is bounded; the omitted middle is recoverable from the spill file.
 */
describe("assistant text elision", () => {
  let sandbox: LocalSandbox;
  let fixtureDir: string;
  beforeEach(async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), "anchor-elision-"));
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
  const head = "HEAD-intent " + "a".repeat(100);
  const tail = "c".repeat(100) + " -TAIL-conclusion";
  const middle = "MIDDLE-" + "b".repeat(45_000);
  const huge = head + middle + tail; // ~45.2k chars

  it("bounds the replay but keeps the transcript whole", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([
      { text: huge, tools: [readTool] },
      { text: "Done." },
    ]);
    const result = await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, onEvent: (e) => events.push(e) },
    );

    // What the model sees on the next call: head + marker + tail.
    const replayed = llm.seen[1]!.messages.filter(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    );
    expect(replayed).toHaveLength(1);
    const sent = replayed[0]!;
    expect(sent.content!.length).toBeLessThan(huge.length);
    expect(sent.content!.startsWith(head)).toBe(true);
    expect(sent.content!.endsWith(tail)).toBe(true);
    expect(sent.content).toContain("chars of this reply were omitted");
    expect(sent.tool_calls).toHaveLength(1);

    // What the consumer persists: untouched.
    const stored = result.messages.filter(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    );
    expect(stored.at(-1)!.content).toBe(huge);

    // The omission is observable.
    const advisory = events.find(
      (e): e is Extract<AgentEvent, { type: "advisory" }> =>
        e.type === "advisory" && e.kind === "assistant_text_elided",
    );
    expect(advisory).toBeDefined();
    expect(advisory!.detail).toContain("omitted");

    // And recoverable, byte for byte, from the spill file.
    const pointer = /full reply saved at (\S+) —/.exec(sent.content!);
    expect(pointer).not.toBeNull();
    expect(await readFile(pointer![1]!, "utf8")).toBe(huge);
    expect(result.completion).toBe("response");
  });

  it("leaves an ordinary reply untouched", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([
      { text: "Reading the file.", tools: [readTool] },
      { text: "Done." },
    ]);
    await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, onEvent: (e) => events.push(e) },
    );
    const replayed = llm.seen[1]!.messages.find(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    );
    expect(replayed!.content).toBe("Reading the file.");
    expect(
      events.some((e) => e.type === "advisory" && e.kind === "assistant_text_elided"),
    ).toBe(false);
  });

  it("keeps only the head of a truncated turn", async () => {
    const cappedText = "HEAD-capped " + "d".repeat(30_000);
    const events: AgentEvent[] = [];
    const llm = scripted([
      { text: cappedText, tools: [readTool], finishReason: "length" },
      { text: "Done." },
    ]);
    const result = await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, onEvent: (e) => events.push(e) },
    );
    const sent = llm.seen[1]!.messages.find(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    )!;
    expect(sent.content!.length).toBeLessThan(DEFAULT_TRUNCATED_REPLY_CHARS + 500);
    expect(sent.content!.length).toBeLessThan(cappedText.length);
    expect(sent.content!.startsWith("HEAD-capped ")).toBe(true);
    // Head-only: the fragment that was cut mid-token is not replayed.
    expect(sent.content!.endsWith("d".repeat(100))).toBe(false);
    // The transcript still holds every character.
    const stored = result.messages.find(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    )!;
    expect(stored.content).toBe(cappedText);
    const advisory = events.find(
      (e): e is Extract<AgentEvent, { type: "advisory" }> =>
        e.type === "advisory" && e.kind === "assistant_text_elided",
    );
    expect(advisory!.detail).toContain("truncated turn");
  });

  it("applies the capped budget below the normal one", async () => {
    // 15k chars: under the 20k replay budget, over the 12k capped budget.
    const llm = scripted([
      { text: "d".repeat(15_000), tools: [readTool], finishReason: "length" },
      { text: "Done." },
    ]);
    await runAgent({ task: "Explain the code" }, { llm, sandbox, agent: codingAgent });
    const sent = llm.seen[1]!.messages.find(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    )!;
    expect(sent.content!.length).toBeLessThan(15_000);
  });

  it("honours a caller-set capped budget, and false drops the stricter rule", async () => {
    const llm = scripted([
      { text: "d".repeat(15_000), tools: [readTool], finishReason: "length" },
      { text: "Done." },
    ]);
    await runAgent(
      { task: "Explain the code" },
      { llm, sandbox, agent: codingAgent, truncatedReplyChars: 3_000 },
    );
    const sent = llm.seen[1]!.messages.find(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    )!;
    expect(sent.content!.length).toBeLessThan(3_500);

    // With the stricter rule off, a capped turn is treated like any other:
    // 15k is under the 20k budget, so nothing is elided.
    const llmOff = scripted([
      { text: "d".repeat(15_000), tools: [readTool], finishReason: "length" },
      { text: "Done." },
    ]);
    const events: AgentEvent[] = [];
    await runAgent(
      { task: "Explain the code" },
      {
        llm: llmOff,
        sandbox,
        agent: codingAgent,
        truncatedReplyChars: false,
        onEvent: (e) => events.push(e),
      },
    );
    const sentOff = llmOff.seen[1]!.messages.find(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    )!;
    expect(sentOff.content!.length).toBe(15_000);
    expect(
      events.some((e) => e.type === "advisory" && e.kind === "assistant_text_elided"),
    ).toBe(false);
  });

  it("can be turned off", async () => {
    const llm = scripted([
      { text: huge, tools: [readTool] },
      { text: "Done." },
    ]);
    await runAgent(
      { task: "Explain the code" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        maxAssistantChars: false,
      },
    );
    const sent = llm.seen[1]!.messages.find(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    );
    expect(sent!.content).toBe(huge);
  });

  it("still bounds the view without a sandbox, with no spill pointer", async () => {
    const events: AgentEvent[] = [];
    const llm = scripted([{ text: huge }]);
    await runAgent(
      { task: "Say hi" },
      { llm, agent: chatAgent, onEvent: (e) => events.push(e) },
    );
    const advisory = events.find(
      (e): e is Extract<AgentEvent, { type: "advisory" }> =>
        e.type === "advisory" && e.kind === "assistant_text_elided",
    );
    expect(advisory).toBeDefined();
    expect(advisory!.detail).toContain("omitted");
    expect(advisory!.detail).not.toContain("full text at");
  });

  it("elideReply is a no-op under budget", () => {
    const elided = elideReply("short", DEFAULT_MAX_ASSISTANT_CHARS);
    expect(elided.omittedChars).toBe(0);
    expect(elided.text).toBe("short");
  });
});
