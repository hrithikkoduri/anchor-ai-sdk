import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "../../src/engine/events.js";
import type { EngineOptions } from "../../src/engine/types.js";
import { runAgent } from "../../src/engine/loop.js";
import { userTurn } from "../../src/engine/types.js";
import { MemoryInboxStore } from "../../src/engine/inbox.js";
import { codingAgent } from "../../src/agents/coding/index.js";
import { workflowAgent, type WorkflowSpec } from "../../src/agents/workflow/index.js";
import { checkEvidence, invokesCheck } from "../../src/engine/workflow.js";
import { bashTool } from "../../src/tools/bash.js";
import { editFileTool } from "../../src/tools/edit-file.js";
import { readFileTool } from "../../src/tools/read-file.js";
import { defineTool } from "../../src/tools/types.js";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import { scaffoldBuggyLib } from "../helpers/buggy-lib.js";
import { call, scripted, type Turn } from "../helpers/scripted.js";

const CHECK = "test -f booted.txt";
const recipeSchema = {
  type: "object",
  properties: {
    start: { type: "string", minLength: 1 },
    port: { type: "integer", minimum: 1 },
  },
  required: ["start", "port"],
  additionalProperties: false,
};
const spec = (overrides: Partial<WorkflowSpec> = {}): WorkflowSpec => ({
  name: "environment",
  brief: "Infer how to boot the app and prove it boots.",
  tools: [bashTool, editFileTool, readFileTool],
  check: { command: CHECK, description: "the boot marker exists" },
  output: { name: "recipe", schema: recipeSchema },
  ...overrides,
});
const bash = (command: string): Turn => call("bash", { command });
const finish = (output?: unknown): Turn =>
  call("finish", { summary: "booted", ...(output !== undefined ? { output } : {}) });
const goodRecipe = { start: "npm start", port: 3000 };

const finishResults = (events: AgentEvent[]) =>
  events.filter(
    (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
      event.type === "tool_result" && event.name === "finish",
  );
const advisories = (events: AgentEvent[], kind: string) =>
  events.filter((event) => event.type === "advisory" && event.kind === kind);
const rejections = (events: AgentEvent[]) =>
  events.filter((event) => event.type === "guardrail" && event.kind === "finish_rejected");

describe("workflowAgent", () => {
  let sandbox: LocalSandbox;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "anchor-workflow-"));
    await scaffoldBuggyLib(dir);
    sandbox = new LocalSandbox({ localPath: dir }, { quiet: true });
    await sandbox.start();
  });
  afterEach(async () => {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  const run = (
    turns: Turn[],
    extra: Partial<EngineOptions> & { spec?: Partial<WorkflowSpec> } = {},
  ) => {
    const events: AgentEvent[] = [];
    const llm = scripted(turns);
    const { spec: overrides, ...opts } = extra;
    const result = runAgent(userTurn("Repository: acme/web"), {
      llm,
      sandbox,
      agent: workflowAgent(spec(overrides)),
      snapshot: false,
      onEvent: (event) => events.push(event),
      ...opts,
    });
    return { result, events, llm };
  };

  it("rejects finish when the check was never run", async () => {
    const { result, events } = run([
      finish(goodRecipe),
      bash(`touch booted.txt && ${CHECK}`),
      finish(goodRecipe),
    ]);
    const done = await result;
    const [first, second] = finishResults(events);
    expect(first!.ok).toBe(false);
    expect(first!.content).toContain("has not been run");
    expect(second!.ok).toBe(true);
    expect(rejections(events)).toHaveLength(1);
    expect(done.reason).toBe("finished");
    expect(done.ok).toBe(true);
  });

  it("does not count a command that merely mentions the check", async () => {
    const { result, events } = run([
      bash(`echo ${CHECK}`),
      finish(goodRecipe),
      bash(`touch booted.txt && ${CHECK}`),
      finish(goodRecipe),
    ]);
    await result;
    const [first] = finishResults(events);
    expect(first!.ok).toBe(false);
    expect(first!.content).toContain("has not been run");
  });

  it("rejects finish when the check failed", async () => {
    const { result, events } = run([
      bash(CHECK),
      finish(goodRecipe),
      bash("touch booted.txt"),
      bash(CHECK),
      finish(goodRecipe),
    ]);
    const done = await result;
    const [first, second] = finishResults(events);
    expect(first!.ok).toBe(false);
    expect(first!.content).toContain("failed (exit 1)");
    expect(second!.ok).toBe(true);
    expect(done.reason).toBe("finished");
  });

  it("withdraws a pass when a file is edited after the check", async () => {
    const { result, events } = run([
      bash(`printf 'before\\n' > notes.txt && touch booted.txt && ${CHECK}`),
      call("edit_file", { path: "notes.txt", old_string: "before", new_string: "after" }),
      finish(goodRecipe),
      bash(CHECK),
      finish(goodRecipe),
    ]);
    const done = await result;
    const [first, second] = finishResults(events);
    expect(first!.ok).toBe(false);
    expect(first!.content).toContain("after the check last passed");
    expect(second!.ok).toBe(true);
    expect(done.ok).toBe(true);
  });

  it("rejects finish on an invalid output with the validation error", async () => {
    const { result, events } = run([
      bash(`touch booted.txt && ${CHECK}`),
      finish({ start: "", port: "3000" }),
      finish(),
      finish(goodRecipe),
    ]);
    const done = await result;
    const [invalid, missing, valid] = finishResults(events);
    expect(invalid!.ok).toBe(false);
    expect(invalid!.content).toContain("$.start: shorter than 1 characters");
    expect(invalid!.content).toContain("$.port: expected integer, got string");
    expect(missing!.ok).toBe(false);
    expect(missing!.content).toContain("`output` (recipe) is required");
    expect(valid!.ok).toBe(true);
    expect(done.output).toEqual(goodRecipe);
  });

  it("accepts a valid output and exposes the parsed value on AgentResult", async () => {
    // A zod-shaped schema: the engine must return what safeParse produced,
    // not the raw arguments.
    const zodLike = {
      safeParse: (value: unknown) =>
        typeof value === "object" && value !== null && "port" in value
          ? { success: true as const, data: { ...(value as object), parsed: true } }
          : {
              success: false as const,
              error: { issues: [{ path: ["port"], message: "Required" }] },
            },
      toJSONSchema: () => ({ type: "object", properties: { port: { type: "integer" } } }),
    };
    const { result, events, llm } = run(
      [bash(`touch booted.txt && ${CHECK}`), finish({}), finish({ port: 8080 })],
      { spec: { output: { name: "recipe", schema: zodLike } } },
    );
    const done = await result;
    expect(finishResults(events)[0]!.content).toContain("$.port: Required");
    expect(done.ok).toBe(true);
    expect(done.completion).toBe("declared");
    expect(done.output).toEqual({ port: 8080, parsed: true });
    // The model was told about the output, and finish requires it.
    const finishDef = llm.seen[0]!.tools!.find((tool) => tool.function.name === "finish")!;
    expect(finishDef.function.parameters).toMatchObject({
      required: ["summary", "output"],
      properties: { output: { type: "object" } },
    });
    expect(Object.keys(finishDef.function.parameters.properties as object)).not.toContain("success");
  });

  it("states the headless contract in the system prompt", async () => {
    const { result, llm } = run([bash(`touch booted.txt && ${CHECK}`), finish(goodRecipe)]);
    await result;
    const system = llm.seen[0]!.messages[0]!.content!;
    expect(system).toContain("No one is reading your output. No one will answer a question.");
    expect(system).toContain("Infer how to boot the app and prove it boots.");
    expect(system).toContain(CHECK);
    expect(system).toContain("`recipe`");
  });

  it("opens on a user turn when the caller passes no messages", async () => {
    const llm = scripted([bash(`touch booted.txt && ${CHECK}`), finish(goodRecipe)]);
    const done = await runAgent(
      { messages: [] },
      { llm, sandbox, agent: workflowAgent(spec()), snapshot: false },
    );
    expect(done.ok).toBe(true);
    expect(llm.seen[0]!.messages[1]).toMatchObject({ role: "user" });
  });

  it("suppresses the conversational nudges", async () => {
    const silent = Array.from({ length: 9 }, (_, index) => bash(`echo step-${index}`));
    const big = { promptTokens: 100, completionTokens: 9_000, totalTokens: 9_100 };
    const { result, events } = run([
      ...silent,
      { text: "Thinking out loud at length...", tools: [{ name: "bash", arguments: JSON.stringify({ command: "echo verbose" }) }], usage: big },
      { text: "I believe the app boots now." },
      bash(`touch booted.txt && ${CHECK}`),
      finish(goodRecipe),
    ]);
    const done = await result;
    expect(advisories(events, "materialization_nudge")).toHaveLength(0);
    expect(advisories(events, "verbose_turn")).toHaveLength(0);
    expect(advisories(events, "prose_checkpoint")).toHaveLength(0);
    // The prose reply did not end the run: it was a rejected finish.
    expect(rejections(events)).toHaveLength(1);
    expect(done.reason).toBe("finished");
    expect(done.ok).toBe(true);
  });

  it("keeps the turn-lifecycle nudges", async () => {
    const same = bash("echo same");
    const { result, events } = run([
      same,
      same,
      same,
      {},
      { text: "partial reply cut off", finishReason: "length" },
      bash(`touch booted.txt && ${CHECK}`),
      finish(goodRecipe),
    ]);
    const done = await result;
    expect(advisories(events, "repeated_call")).toHaveLength(1);
    expect(advisories(events, "empty_turn")).toHaveLength(1);
    expect(advisories(events, "output_cap_continue")).toHaveLength(1);
    expect(done.ok).toBe(true);
  });

  it("ends as budget_exhausted at maxTurns", async () => {
    const { result, llm } = run(
      [bash("echo one"), bash("echo two"), bash("echo three")],
      { spec: { budget: { maxTurns: 2 } } },
    );
    const done = await result;
    expect(done.reason).toBe("budget_exhausted");
    expect(done.ok).toBe(false);
    expect(done.error).toContain("workflow budget exhausted");
    expect(done.output).toBeUndefined();
    expect(llm.seen).toHaveLength(2);
  });

  it("is one-shot: an inbox is refused", async () => {
    await expect(
      runAgent(userTurn("go"), {
        llm: scripted([]),
        sandbox,
        agent: workflowAgent(spec()),
        inbox: { store: new MemoryInboxStore(), channel: "t1" },
      }),
    ).rejects.toThrow(/one-shot/);
  });

  it("never carries ask_questions", async () => {
    const ask = defineTool(
      {
        name: "ask_questions",
        description: "ask the user",
        parameters: { type: "object", properties: {} },
      },
      async () => ({ ok: true, content: "" }),
    );
    expect(() => workflowAgent(spec({ tools: [bashTool, ask] }))).toThrow(/ask_questions/);
    await expect(
      runAgent(userTurn("go"), {
        llm: scripted([]),
        sandbox,
        agent: workflowAgent(spec()),
        tools: [bashTool, ask],
      }),
    ).rejects.toThrow(/ask_questions/);
    const { result, llm } = run([bash(`touch booted.txt && ${CHECK}`), finish(goodRecipe)]);
    await result;
    const names = llm.seen[0]!.tools!.map((tool) => tool.function.name);
    expect(names).not.toContain("ask_questions");
  });
});

describe("normal agents keep their conversational guardrails", () => {
  let sandbox: LocalSandbox;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "anchor-workflow-coding-"));
    await scaffoldBuggyLib(dir);
    sandbox = new LocalSandbox({ localPath: dir }, { quiet: true });
    await sandbox.start();
  });
  afterEach(async () => {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  it("codingAgent still gets its silent nudge and prose checkpoint", async () => {
    const events: AgentEvent[] = [];
    const silent = Array.from({ length: 8 }, (_, index) =>
      call("read_file", { path: index % 2 ? "src/lib.js" : "package.json" }),
    );
    const llm = scripted([
      ...silent,
      { text: "Status: still investigating." },
      { text: "Done.", tools: [{ name: "finish", arguments: JSON.stringify({ summary: "done" }) }] },
    ]);
    const done = await runAgent(userTurn("Fix the bug"), {
      llm,
      sandbox,
      agent: codingAgent,
      snapshot: false,
      onEvent: (event) => events.push(event),
    });
    expect(advisories(events, "materialization_nudge")).toHaveLength(1);
    expect(advisories(events, "prose_checkpoint")).toHaveLength(1);
    expect(done.reason).toBe("finished");
    expect(done.output).toBeUndefined();
  });

  it("codingAgent still gets its verbose-turn nudge", async () => {
    const events: AgentEvent[] = [];
    const big = { promptTokens: 100, completionTokens: 9_000, totalTokens: 9_100 };
    const llm = scripted([
      { text: "Long deliberation...", tools: [{ name: "read_file", arguments: JSON.stringify({ path: "src/lib.js" }) }], usage: big },
      { text: "Done." },
    ]);
    await runAgent(userTurn("Fix the bug"), {
      llm,
      sandbox,
      agent: codingAgent,
      snapshot: false,
      onEvent: (event) => events.push(event),
    });
    expect(advisories(events, "verbose_turn")).toHaveLength(1);
  });
});

describe("check evidence", () => {
  it("accepts the check as the final command, optionally after cd &&", () => {
    expect(invokesCheck("npm test", "npm test")).toBe(true);
    expect(invokesCheck("cd app && npm  test", "npm test")).toBe(true);
    expect(invokesCheck("cd app\nnpm test 2>&1", "npm test")).toBe(true);
  });

  it("refuses commands that do not run it or mask its status", () => {
    expect(invokesCheck("echo npm test", "npm test")).toBe(false);
    expect(invokesCheck("npm test || true", "npm test")).toBe(false);
    expect(invokesCheck("npm test | tee log", "npm test")).toBe(false);
    expect(invokesCheck("true || npm test", "npm test")).toBe(false);
    expect(invokesCheck("exit 0; npm test", "npm test")).toBe(false);
    expect(invokesCheck("npm() { :; }; npm test", "npm test")).toBe(false);
    expect(invokesCheck("bash -c 'npm test'", "npm test")).toBe(false);
  });

  it("reads the latest engine-recorded bash result", () => {
    const ran = (exitCode: number) => ({
      tool: "bash",
      ok: exitCode === 0,
      meta: { command: "npm test", exitCode, timedOut: false },
    });
    expect(checkEvidence([], "npm test").status).toBe("missing");
    expect(checkEvidence([ran(1), ran(0)], "npm test").status).toBe("passed");
    expect(checkEvidence([ran(0), ran(1)], "npm test").status).toBe("failed");
    expect(
      checkEvidence([{ tool: "batch", ok: true, meta: { command: "npm test" } }], "npm test").status,
    ).toBe("missing");
    expect(
      checkEvidence(
        [{ tool: "bash", ok: true, meta: { command: "npm test", background: { jobId: "j1" } } }],
        "npm test",
      ).status,
    ).toBe("running");
  });
});
