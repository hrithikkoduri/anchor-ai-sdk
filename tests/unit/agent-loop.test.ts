import { afterEach, describe, expect, it } from "vitest";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runAgent } from "../../src/engine/loop.js";
import { MemoryThreadStore } from "../../src/engine/thread.js";
import { chatAgent, chatStrategy } from "../../src/agents/chat/index.js";
import { codingAgent, codingStrategy } from "../../src/agents/coding/index.js";
import { defineTool } from "../../src/tools/types.js";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";
import type { AgentEvent } from "../../src/engine/events.js";

function model(
  turns: Array<{
    text?: string;
    calls?: Array<{ name: string; args?: Record<string, unknown> }>;
  }>,
): LLMClient & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = [];
  return {
    seen,
    model: "scripted",
    complete: async () => {
      throw new Error("unexpected compaction");
    },
    stream: async (request) => {
      seen.push(structuredClone(request));
      const turn = turns.shift();
      if (!turn) throw new Error("out of scripted responses");
      return {
        text: turn.text ?? "",
        toolCalls: (turn.calls ?? []).map((call, i) => ({
          id: `call-${seen.length}-${i}`,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        })),
        model: "scripted",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        latencyMs: 1,
      } satisfies LLMResponse;
    },
  };
}

describe("natural agent loop", () => {
  let sandbox: LocalSandbox | undefined;
  afterEach(async () => {
    await sandbox?.destroy();
    sandbox = undefined;
  });

  it("removes unwanted README test scaffolding without inventing a failing test or a default suite", async () => {
    sandbox = new LocalSandbox({}, { quiet: true });
    await sandbox.start();
    await writeFile(
      path.join(sandbox.workspace, "README.md"),
      "# Notebook project\n",
    );
    await mkdir(path.join(sandbox.workspace, "tests"));
    await writeFile(
      path.join(sandbox.workspace, "tests/test_readme.sh"),
      "test -f README.md\n",
    );
    await writeFile(
      path.join(sandbox.workspace, "package.json"),
      '{"scripts":{"test":"bash tests/test_readme.sh"}}',
    );
    await sandbox.checkpoint("fixture before review");
    const store = new MemoryThreadStore();
    await store.save("review", {
      phase: "reproduce",
      messages: [
        { role: "user", content: "Add a README" },
        {
          role: "user",
          origin: "engine",
          content: "PHASE: reproduce — produce a failing test",
        },
        {
          role: "user",
          origin: "engine",
          content:
            'You have spent 21 turns in the "fix" phase (soft limit 20). Keep working.',
        },
        { role: "assistant", content: "Added README and test scaffolding." },
      ],
    });
    const task =
      "The reviewer says we do not need a test file. Remove the test scaffolding you added, keeping README.md.";
    const llm = model([
      {
        calls: [
          {
            name: "bash",
            args: {
              command:
                "rm tests/test_readme.sh package.json && rmdir tests && git diff --stat",
            },
          },
        ],
      },
      {
        text: "Removed the redundant test script and package manifest. Kept the README. Inspected the diff; no test suite remains or was manufactured.",
      },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent(
      { task },
      {
        llm,
        sandbox,
        agent: codingAgent,
        thread: { store, id: "review" },
        onEvent: (event) => events.push(event),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      reason: "finished",
      completion: "response",
      phase: "understand",
      steps: 2,
    });
    expect(llm.seen[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: task,
    });
    expect(
      llm.seen[0]!.messages.some((message) =>
        /PHASE:|soft limit|Begin the task/.test(message.content ?? ""),
      ),
    ).toBe(false);
    expect(
      llm.seen[0]!.tools?.some((tool) => tool.function.name === "advance"),
    ).toBe(false);
    expect(events.some((event) => event.type === "guardrail")).toBe(false);
    expect(result.evidence?.map((item) => item.tool)).toEqual(["bash"]);
    expect(
      await readFile(path.join(sandbox.workspace, "README.md"), "utf8"),
    ).toBe("# Notebook project\n");
    await expect(
      access(path.join(sandbox.workspace, "tests/test_readme.sh")),
    ).rejects.toThrow();
    await expect(
      access(path.join(sandbox.workspace, "package.json")),
    ).rejects.toThrow();
    const saved = await store.load("review");
    expect(saved!.messages.some((message) => message.content === task)).toBe(
      true,
    );
    expect(
      saved!.messages.some((message) =>
        /PHASE:|soft limit/.test(message.content ?? ""),
      ),
    ).toBe(false);
    expect(result.checkpointRef).toMatch(/^[a-f0-9]{40}$/);
    expect(codingStrategy).not.toHaveProperty("checkFinish");
  });

  it("tool failure is an observation; the agent may report a limitation and end normally", async () => {
    const fail = defineTool(
      { name: "inspect", description: "Inspect", parameters: {} },
      async () => ({ ok: false, content: "Execution completion is unknown." }),
    );
    const llm = model([
      { calls: [{ name: "inspect" }] },
      {
        text: "I could not inspect the result; I have not retried the operation or claimed success.",
      },
    ]);
    const result = await runAgent(
      { task: "inspect the result" },
      { llm, strategy: chatStrategy, tools: [fail] },
    );
    expect(result).toMatchObject({
      reason: "finished",
      completion: "response",
      steps: 2,
    });
    expect(result.evidence).toMatchObject([{ tool: "inspect", ok: false }]);
    expect(llm.seen).toHaveLength(2);
    expect(
      llm.seen[1]!.messages.some((message) =>
        (message.content ?? "").includes("Keep working"),
      ),
    ).toBe(false);
  });

  it("a new review request preserves genuine conversation, not runtime commands", async () => {
    const store = new MemoryThreadStore();
    await store.save("t", {
      messages: [
        { role: "user", content: "Fix the parser" },
        {
          role: "user",
          origin: "engine",
          content:
            "This internal instruction should not become a user request.",
        },
        { role: "assistant", content: "Updated parser.ts." },
      ],
    });
    const llm = model([{ text: "Here are my findings; I made no changes." }]);
    await runAgent(
      { task: "Review only. Do not edit." },
      { llm, agent: chatAgent, thread: { store, id: "t" } },
    );
    const history = llm.seen[0]!.messages;
    expect(history.at(-1)).toEqual({
      role: "user",
      content: "Review only. Do not edit.",
    });
    expect(
      history.some((message) => message.content === "Fix the parser"),
    ).toBe(true);
    expect(history.some((message) => message.origin === "engine")).toBe(false);
  });

  it("cancels before tools and answers every call in a batch without executing it", async () => {
    const controller = new AbortController();
    let executed = 0;
    const mutate = defineTool(
      { name: "mutate", description: "Mutate", parameters: {} },
      async () => {
        executed++;
        return { ok: true, content: "changed" };
      },
    );
    const llm = model([{ calls: [{ name: "mutate" }, { name: "mutate" }] }]);
    const stream = llm.stream;
    llm.stream = async (...args) => {
      const response = await stream(...args);
      controller.abort();
      return response;
    };
    const result = await runAgent(
      { task: "work" },
      {
        llm,
        strategy: chatStrategy,
        tools: [mutate],
        signal: controller.signal,
      },
    );
    expect(result.reason).toBe("cancelled");
    expect(executed).toBe(0);
    expect(
      result.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(2);
  });

  it("course-corrects one empty turn, then stalls on a second", async () => {
    const events: AgentEvent[] = [];
    const continued = await runAgent(
      { task: "inspect" },
      {
        llm: model([{}, { text: "Done." }, { text: "Done." }]),
        strategy: chatStrategy,
        onEvent: (event) => events.push(event),
      },
    );
    expect(continued.reason).toBe("finished");
    expect(
      events.some((event) => event.type === "advisory" && event.kind === "empty_turn"),
    ).toBe(true);

    const stalled = await runAgent(
      { task: "inspect" },
      { llm: model([{}, {}]), strategy: chatStrategy },
    );
    expect(stalled.reason).toBe("stalled");
    expect(stalled.error).toContain("neither text nor tool calls");
  });

  it("course-corrects the first identical-call loop instead of ending", async () => {
    let executed = 0;
    const inspect = defineTool(
      { name: "inspect", description: "Inspect", parameters: {} },
      async () => {
        executed++;
        return { ok: false, content: "unavailable" };
      },
    );
    const events: AgentEvent[] = [];
    const llm = model([
      ...Array.from({ length: 3 }, () => ({ calls: [{ name: "inspect" }] })),
      { text: "Done a different way." },
      { text: "Done a different way." },
    ]);
    const result = await runAgent(
      { task: "inspect" },
      {
        llm,
        strategy: chatStrategy,
        tools: [inspect],
        onEvent: (event) => events.push(event),
      },
    );
    expect(result.reason).toBe("finished");
    expect(executed).toBe(2);
    expect(
      events.some((event) => event.type === "advisory" && event.kind === "repeated_call"),
    ).toBe(true);
    expect(
      llm.seen.some((request) =>
        request.messages.some((message) => message.content?.includes("was not executed")),
      ),
    ).toBe(true);
  });

  it("stops if the same identical-call loop happens again", async () => {
    let executed = 0;
    const inspect = defineTool(
      { name: "inspect", description: "Inspect", parameters: {} },
      async () => {
        executed++;
        return { ok: false, content: "unavailable" };
      },
    );
    const llm = model(
      Array.from({ length: 6 }, () => ({ calls: [{ name: "inspect" }] })),
    );
    const result = await runAgent(
      { task: "inspect" },
      { llm, strategy: chatStrategy, tools: [inspect] },
    );
    expect(result.reason).toBe("stalled");
    expect(result.error).toContain("second time");
    expect(executed).toBe(4);
  });

  it("advises a visible reply after consecutive tool-only turns", async () => {
    sandbox = new LocalSandbox({}, { quiet: true });
    await sandbox.start();
    const store = new MemoryThreadStore();
    const events: AgentEvent[] = [];
    const llm = model([
      ...Array.from({ length: 8 }, (_, index) => ({
        calls: [{ name: "bash", args: { command: `echo state ${index + 1}` } }],
      })),
      { text: "Here is the status you asked for." },
      // #78: the prose answered the nudge, so it is checked once. The model
      // repeats itself and the run ends on its own terms.
      { text: "Here is the status you asked for." },
    ]);
    const result = await runAgent(
      { task: "Status?" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        thread: { store, id: "nudge" },
        onEvent: (event) => events.push(event),
      },
    );
    expect(result).toMatchObject({ reason: "finished", steps: 10 });
    const ninth = llm.seen[8]!;
    expect(
      ninth.messages.some(
        (message) =>
          message.origin === "engine" &&
          (message.content ?? "").includes("without writing anything visible"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "advisory" && event.kind === "materialization_nudge",
      ),
    ).toBe(true);
    // Runtime-only: the advisory never becomes durable conversation.
    const saved = await store.load("nudge");
    expect(saved!.messages.some((message) => message.origin === "engine")).toBe(
      false,
    );
  });

  it("the advisory respects its dial, including repeated sustained silence", async () => {
    sandbox = new LocalSandbox({}, { quiet: true });
    await sandbox.start();
    const llm = model([
      ...Array.from({ length: 4 }, (_, index) => ({
        calls: [{ name: "bash", args: { command: `echo x ${index + 1}` } }],
      })),
      { text: "Done." },
      { text: "Done." },
    ]);
    const events: AgentEvent[] = [];
    await runAgent(
      { task: "Status?" },
      {
        llm,
        sandbox,
        agent: codingAgent,
        guardrails: { toolOnlyNudgeLimit: 2 },
        onEvent: (event) => events.push(event),
      },
    );
    const advisories = events.filter((event) => event.type === "advisory");
    expect(
      advisories.filter((event) => event.kind === "materialization_nudge"),
    ).toHaveLength(2);
    // #78: the prose that answered the last nudge is checked once.
    expect(
      advisories.filter((event) => event.kind === "prose_checkpoint"),
    ).toHaveLength(1);

    const off = model([
      { calls: [{ name: "bash", args: { command: "echo 1" } }] },
      { calls: [{ name: "bash", args: { command: "echo 2" } }] },
      { calls: [{ name: "bash", args: { command: "echo 3" } }] },
      { text: "Done." },
    ]);
    const quiet: AgentEvent[] = [];
    await runAgent(
      { task: "Status?" },
      {
        llm: off,
        sandbox,
        agent: codingAgent,
        guardrails: { toolOnlyNudgeLimit: false },
        onEvent: (event) => quiet.push(event),
      },
    );
    expect(quiet.some((event) => event.type === "advisory")).toBe(false);
  });
});
