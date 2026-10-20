import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const entry =
  process.env.ANCHOR_SDK_ENTRY ??
  fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const sdkUrl = pathToFileURL(entry).href;
const sdk = await import(sdkUrl);
const sources = await Promise.all(
  ["runtime-configuration.jsx", "integration-guides.jsx", "message-delivery.jsx", "background-guide.jsx", "composition-guide.jsx"].map((name) =>
    readFile(new URL("../src/" + name, import.meta.url), "utf8"),
  ),
);
function literalValue(literal) {
  return new Function("return (" + literal + ")")();
}
function namedCode(name) {
  const expression = new RegExp(
    "(?:export )?const " + name + " = (`(?:\\\\[\\s\\S]|[^`])*`)",
  );
  const match = sources.join("\n").match(expression);
  assert.ok(match, "Missing snippet " + name);
  return literalValue(match[1]);
}
async function loadCode(code) {
  const linked = code
    .replaceAll('"anchor-ai-sdk"', JSON.stringify(sdkUrl))
    .replaceAll('"anchor-ai-sdk/sandbox/heyo"', JSON.stringify(new URL("./sandbox/heyo/index.js", sdkUrl).href));
  return import(
    `data:text/javascript;base64,${Buffer.from(linked).toString("base64")}`
  );
}

test("configuration snippets parse and imported SDK names exist", () => {
  let count = 0;
  for (const source of sources) {
    for (const match of source.matchAll(/`(?:\\[\s\S]|[^`])*`/g)) {
      if (!match[0].includes("\n") && !match[0].includes("\\n")) continue;
      const code = literalValue(match[0]);
      try {
        new vm.SourceTextModule(code);
      } catch (error) {
        // The explicitly labeled run-options fragment is an object body.
        if (code.includes("// Inside runAgent(task, options):"))
          new vm.SourceTextModule("const options = {\n" + code + "\n};");
        else throw error;
      }
      for (const imports of code.matchAll(
        /import\s*\{([^}]+)\}\s*from\s*["']anchor-ai-sdk["']/g,
      )) {
        for (const name of imports[1]
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean))
          assert.ok(name in sdk, name);
      }
      count++;
    }
  }
  assert.ok(count >= 15, "Expected the complete configuration snippet set");
});

const backgroundToolSource = await readFile(
  new URL("../src/examples/background-tool.mjs", import.meta.url), "utf8",
);

function execResult(output = "checks passed") {
  return { exitCode: 0, stdout: output, stderr: "", output, timedOut: false, durationMs: 1 };
}

function scriptedModel(next) {
  return {
    model: "offline-docs",
    async complete() { throw new Error("Unexpected compaction"); },
    async stream(request) {
      const toolCalls = await next(request);
      return {
        text: "", toolCalls, model: this.model, latencyMs: 0,
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, costUsd: 0.01 },
      };
    },
  };
}

const finishCall = () => [{ id: "finish", name: "finish", arguments: '{"summary":"Done"}' }];

test("downloaded background tool uses public exports, opt-in, deadline and receipt metadata", async () => {
  new vm.SourceTextModule(backgroundToolSource);
  const { projectChecksTool: tool } = await loadCode(backgroundToolSource);
  assert.equal(tool.background, true);
  for (const threshold of [undefined, 0, 15, 600, 900]) {
    let options;
    const sandbox = {
      pollJob: async () => undefined,
      exec: async (command, opts) => {
        assert.equal(command, "npm test");
        options = opts;
        return opts.backgroundAfterSecs ? { ...execResult(), background: { jobId: "checks-1" } } : execResult();
      },
    };
    const result = await tool.run({}, { sandbox, backgroundAfterSecs: threshold });
    assert.equal(result.ok, true);
    assert.equal(options.timeoutSecs, 600);
    assert.equal(options.backgroundAfterSecs, threshold === 15 ? 15 : undefined);
    if (threshold === 15) {
      assert.equal(result.meta.background.jobId, "checks-1");
      assert.equal(result.meta.timeoutSecs, 600);
      assert.equal(result.meta.command, "npm test");
    }
  }
  let syncOptions;
  await tool.run({}, { sandbox: { exec: async (_, options) => { syncOptions = options; return execResult(); } }, backgroundAfterSecs: 15 });
  assert.equal(syncOptions.backgroundAfterSecs, undefined);
  assert.equal((await tool.run({ unexpected: true }, {})).ok, false);
  assert.equal((await tool.run({}, {})).ok, false);
  assert.equal(sdk.execPolicy, undefined, "0.1.7 does not export the internal helper");
});

test("built-in bash honors tool permission and a shorter explicit deadline", async () => {
  let options;
  const sandbox = {
    pollJob: async () => undefined,
    exec: async (_, opts) => { options = opts; return execResult(); },
  };
  await sdk.bashTool.run({ command: "true", timeout_secs: 5 }, { sandbox, backgroundAfterSecs: 15 });
  assert.equal(options.timeoutSecs, 5);
  assert.equal(options.backgroundAfterSecs, undefined);
  await sdk.bashTool.run({ command: "true" }, { sandbox, backgroundAfterSecs: 15 });
  assert.equal(options.timeoutSecs, 3600);
  assert.equal(options.backgroundAfterSecs, 15);
  assert.notEqual(sdk.runTestsTool().background, true);
});

for (const delivery of ["queue", "interject"]) {
  test(`native ${delivery} carries jobs, persists runtime facts and accounts chain usage`, async () => {
    const { projectChecksTool } = await loadCode(backgroundToolSource);
    const inbox = new sdk.MemoryInboxStore();
    const thread = new sdk.MemoryThreadStore();
    const events = [], records = [], requests = [];
    const sinkCode = namedCode("sinkExample").split("// Your app must implement")[0];
    const { databaseTraceSink } = await loadCode(sinkCode);
    let calls = 0, polls = 0;
    const sandbox = {
      id: "offline-heyo", backend: "fixture", workspace: "/repo", scratch: "/scratch",
      async exec() {
        await inbox.push({ id: delivery + "-1", channel: "test", text: "Follow up on checks", delivery });
        return { ...execResult(), background: { jobId: "checks-1" } };
      },
      async pollJob() {
        polls++;
        return delivery === "queue" && polls === 1 ? undefined : execResult();
      },
    };
    const llm = scriptedModel(request => {
      requests.push(structuredClone(request));
      calls++;
      return calls === 1
        ? [{ id: "checks", name: "project_checks", arguments: "{}" }]
        : finishCall();
    });
    const result = await sdk.runAgent({ task: "Initial checks" }, {
      llm, agent: sdk.chatAgent, sandbox, snapshot: false,
      tools: [projectChecksTool], backgroundAfterSecs: 15,
      thread: { store: thread, id: "test" }, inbox: { store: inbox, channel: "test" },
      onEvent: event => events.push(event),
      traceSinks: [databaseTraceSink("chain", async row => records.push(row))],
    });
    assert.equal(result.runs.length, 2);
    assert.equal(result.runs[0].reason, delivery === "interject" ? "interrupted" : "finished");
    assert.equal(result.reason, "finished");
    assert.equal(result.pendingJobs, undefined);
    assert.equal(result.usage.totalTokens, calls * 20);
    assert.equal(result.runs.reduce((sum, run) => sum + run.usage.totalTokens, 0), result.usage.totalTokens);
    assert.equal(await inbox.hasPending("test"), false);
    assert.ok(events.some(event => event.type === "background_started"));
    assert.ok(events.some(event => event.type === "background_completed"));
    const runtime = (await thread.load("test")).messages.filter(message => message.origin === "runtime");
    assert.ok(runtime.some(message => message.content.includes("checks passed")));
    assert.ok(requests.at(-1).messages.some(message => message.content?.includes("checks passed")));
    const starts = records.filter(row => row.type === "run_started");
    assert.deepEqual(starts.map(row => row.segment), [0, 1]);
    assert.equal(starts[0].seq, starts[1].seq, "seq resets, segment disambiguates");
    assert.equal(new Set(records.map(row => `${row.runId}:${row.segment}:${row.seq}`)).size, records.length);
  });
}

test("budget-bound pending jobs can resume on the same machine in another call", async () => {
  const { projectChecksTool } = await loadCode(backgroundToolSource);
  const thread = new sdk.MemoryThreadStore();
  const sandbox = {
    id: "retained", backend: "fixture", workspace: "/repo", scratch: "/scratch",
    exec: async () => ({ ...execResult(), background: { jobId: "carry-1" } }),
    pollJob: async () => execResult("resumed checks passed"),
  };
  const first = await sdk.runAgent({ task: "Start checks" }, {
    llm: scriptedModel(() => [{ id: "checks", name: "project_checks", arguments: "{}" }]),
    agent: sdk.chatAgent, sandbox, snapshot: false, tools: [projectChecksTool],
    budgets: { maxSteps: 1 }, backgroundAfterSecs: 15,
    thread: { store: thread, id: "resume" },
  });
  assert.equal(first.reason, "max_steps");
  assert.equal(first.pendingJobs[0].jobId, "carry-1");
  const next = await sdk.runAgent({ task: "Continue checks" }, {
    llm: scriptedModel(request => {
      assert.ok(request.messages.some(message => message.content?.includes("resumed checks passed")));
      return finishCall();
    }),
    agent: sdk.chatAgent, sandbox, snapshot: false, resumeJobs: first.pendingJobs,
    thread: { store: thread, id: "resume" },
  });
  assert.equal(next.reason, "finished");
  assert.equal(next.pendingJobs, undefined);
});

test("native inbox batches in documented order and deduplicates stable IDs", async () => {
  const inbox = new sdk.MemoryInboxStore();
  for (const [id, delivery] of [["q1", "queue"], ["i1", "interject"], ["q2", "queue"], ["i2", "interject"]]) {
    assert.equal(await inbox.push({ id, channel: "ordering", text: id, delivery }), "queued");
  }
  assert.equal(await inbox.push({ id: "q1", channel: "ordering", text: "repeat", delivery: "queue" }), "duplicate");
  const batch = await inbox.claimAll("ordering");
  assert.deepEqual(batch.map(message => message.id), ["i2", "i1", "q1", "q2"]);
  assert.equal((await inbox.claimAll("ordering")).length, 0);
  await inbox.release(batch.map(message => message.id));
  assert.equal((await inbox.claimAll("ordering")).length, 4);
  await inbox.complete(batch.map(message => message.id));
  assert.equal(await inbox.hasPending("ordering"), false);
});

const harnessSource = await readFile(
  new URL("../src/examples/repository-harness.mjs", import.meta.url), "utf8",
);

test("phase data connects to the strategy, agent and live phase control", async () => {
  const source = await readFile(new URL("../src/examples/policy-agent.mjs", import.meta.url), "utf8");
  const { policyPhases, policyStrategy, policyAgent } = await loadCode(source);
  assert.equal(policyStrategy.phases, policyPhases);
  assert.equal(policyAgent.strategy, policyStrategy);
  const prompt = policyStrategy.systemPrompt({ task: "policy", context: "region=eu", summary: "Earlier lookup" });
  for (const phase of policyPhases) assert.ok(prompt.includes(phase.goal));
  assert.ok(prompt.includes("region=eu"));
  assert.ok(prompt.includes("Earlier lookup"));
  const events = [];
  let calls = 0;
  const result = await sdk.runAgent({ task: "Answer a policy question" }, {
    llm: scriptedModel(() => ++calls === 1
      ? [{ id: "phase", name: "set_phase", arguments: '{"phase":"answer"}' }]
      : finishCall()),
    agent: policyAgent, onEvent: event => events.push(event),
  });
  assert.deepEqual(events.filter(event => event.type === "phase_started").map(event => event.phase), ["lookup", "answer"]);
  assert.equal(result.phase, "answer");
  assert.equal(result.reason, "finished");
  assert.ok(!result.evidence.some(item => item.tool === "lookup_policy"), "A phase/required tool does not enforce its execution");
  const skipped = await sdk.runAgent({ task: "Finish directly" }, {
    llm: scriptedModel(finishCall), agent: policyAgent,
  });
  assert.equal(skipped.phase, "lookup");
  assert.equal(skipped.reason, "finished", "Finishing does not require visiting the final phase");
});

test("assembled repository harness runs composed phases and tools with state, traces and cleanup", async () => {
  new vm.SourceTextModule(harnessSource);
  const { reviewPhases, reviewStrategy, reviewAgent, reviewRepository } = await loadCode(harnessSource);
  assert.equal(reviewStrategy.phases, reviewPhases);
  assert.equal(reviewAgent.strategy, reviewStrategy);
  assert.deepEqual(reviewAgent.tools.map(tool => tool.definition.name), ["read_file", "search", "bash", "run_tests"]);
  let starts = 0, destroys = 0, step = 0;
  const commands = [], rows = [], requests = [];
  const sandbox = {
    id: "fixture", backend: "fixture", workspace: "/repo", scratch: "/scratch",
    async start() { starts++; },
    async destroy() { destroys++; },
    async hasChangesFrom() { return false; },
    async exec(command, options) {
      commands.push({ command, options });
      return execResult(command.includes("git write-tree") ? "a".repeat(40) : "fixture checks passed");
    },
  };
  const calls = [
    { name: "set_phase", arguments: '{"phase":"inspect"}' },
    { name: "bash", arguments: '{"command":"pwd"}' },
    { name: "set_phase", arguments: '{"phase":"validate"}' },
    { name: "run_tests", arguments: '{"command":"npm test"}' },
    { name: "finish", arguments: '{"summary":"Reviewed with observed checks"}' },
  ];
  const threadStore = new sdk.MemoryThreadStore();
  const inboxStore = new sdk.MemoryInboxStore();
  const outcome = await reviewRepository({
    llm: scriptedModel(request => { requests.push(structuredClone(request)); return [{ id: "call-" + step, ...calls[step++] }]; }),
    compaction: false, provider: { create: spec => { assert.equal(spec.repoUrl, "https://example.invalid/repo"); return sandbox; } },
    repoUrl: "https://example.invalid/repo", task: "Review execution", context: "Authorized context",
    threadId: "assembled", threadStore, inboxStore,
    traceSinks: [{ name: "fixture", record: row => rows.push(row) }],
  });
  assert.equal(starts, 1);
  assert.equal(destroys, 1);
  assert.equal(outcome.result.reason, "finished");
  assert.equal(outcome.result.usage.totalTokens, 100);
  assert.equal(outcome.observedChecks.length, 1);
  assert.equal(outcome.observedChecks[0].meta.ran, true);
  assert.equal(outcome.observedChecks[0].meta.treeHash, "a".repeat(40));
  assert.equal(outcome.result.runs.length, 1);
  assert.ok((await threadStore.load("assembled")).messages.length > 0);
  assert.deepEqual(rows.filter(row => row.event.type === "phase_started").map(row => row.event.phase), ["understand", "inspect", "validate"]);
  assert.ok(rows.some(row => row.event.type === "run_finished"));
  assert.ok(requests[0].messages[0].content.includes("Authorized context"));
  assert.ok(commands.every(({ options }) => options?.backgroundAfterSecs === undefined));
});

test("assembled harness destroys the workspace if startup fails", async () => {
  const { reviewRepository } = await loadCode(harnessSource);
  let destroys = 0;
  await assert.rejects(reviewRepository({
    provider: { create: () => ({ start: async () => { throw new Error("fixture boot failure"); }, destroy: async () => { destroys++; } }) },
  }), /fixture boot failure/);
  assert.equal(destroys, 1);
});

test("homepage composition code uses real primitives and runs with host dependencies", async () => {
  const source = await readFile(new URL("../src/examples/landing-agent.mjs", import.meta.url), "utf8");
  new vm.SourceTextModule(source);
  const [definitions, call] = source.split("// Supply your llm");
  const module = await loadCode(definitions + "\nexport async function demo(llm, sandbox) {\n// Supply your llm" + call + "\nreturn result;\n}");
  assert.equal(module.strategy.phases, module.phases);
  assert.equal(module.agent.strategy, module.strategy);
  assert.deepEqual(module.agent.tools.map(tool => tool.definition.name), ["search", "read_file"]);
  const result = await module.demo(scriptedModel(finishCall), {
    id: "fixture", backend: "fixture", hasChangesFrom: async () => false,
  });
  assert.equal(result.reason, "finished");
});

test("documented compaction helper settings match actual output", () => {
  assert.deepEqual(sdk.compactionForContextWindow(128_000), {
    maxEstimatedTokens: 70_400,
    keepRecentTokens: 17_600,
  });
  assert.deepEqual(
    sdk.compactionForContextWindow(128_000, { ceiling: 60_000, floor: 24_000 }),
    { maxEstimatedTokens: 60_000, keepRecentTokens: 15_000 },
  );
});

test("runtime compaction emits an event, accounts usage and persists the summary", async () => {
  const store = new sdk.MemoryThreadStore();
  await store.save("compact-fixture", {
    messages: [
      { role: "user", content: "Older request ".repeat(300) },
      { role: "assistant", content: "Older observation ".repeat(300) },
      { role: "user", content: "Follow-up ".repeat(300) },
      { role: "assistant", content: "Recent detail ".repeat(100) },
    ],
    phase: "respond",
  });
  const events = [];
  let streamedRequest;
  const response = (text) => ({
    text,
    toolCalls: [],
    usage: {
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
      costUsd: 0.01,
    },
    model: "fixture",
    latencyMs: 0,
  });
  const llm = {
    model: "fixture",
    async complete() {
      return response("Earlier context summarised.");
    },
    async stream(request) {
      streamedRequest = request;
      return response("Answer.");
    },
  };
  const result = await sdk.runAgent(
    { task: "Current question" },
    {
      llm,
      agent: sdk.chatAgent,
      snapshot: false,
      thread: { store, id: "compact-fixture" },
      compaction: { maxEstimatedTokens: 100, keepRecentTokens: 10 },
      onEvent: (event) => events.push(event),
    },
  );
  assert.equal(result.usage.totalTokens, 40);
  assert.ok(
    events.some(
      (event) => event.type === "compacted" && event.removedMessages > 0,
    ),
  );
  assert.equal(
    (await store.load("compact-fixture")).summary,
    "Earlier context summarised.",
  );
  assert.ok(
    streamedRequest.messages.some(
      (message) => message.content === "Current question",
    ),
  );
  assert.ok(
    streamedRequest.messages[0].content.includes("Earlier context summarised."),
  );
});

test("verbosity nudge excludes reported reasoning in the reviewed SDK", async () => {
  for (const hidden of [true, false]) {
    const events = [];
    let calls = 0;
    const llm = {
      model: "fixture",
      async complete(request, options) {
        return this.stream(request, () => {}, options);
      },
      async stream() {
        calls++;
        return {
          text: "",
          model: this.model,
          latencyMs: 0,
          toolCalls: [
            {
              id: "call-" + calls,
              name: calls === 1 ? "noop" : "finish",
              arguments: calls === 1 ? "{}" : '{"summary":"Done"}',
            },
          ],
          usage: {
            promptTokens: 10,
            completionTokens: calls === 1 ? (hidden ? 21_000 : 9_000) : 10,
            totalTokens: calls === 1 ? (hidden ? 21_010 : 9_010) : 20,
            ...(hidden && calls === 1 ? { reasoningTokens: 20_000 } : {}),
            costUsd: 0.01,
          },
        };
      },
    };
    await sdk.runAgent(
      { task: "Fixture" },
      {
        llm,
        agent: sdk.chatAgent,
        snapshot: false,
        tools: [
          sdk.defineTool(
            {
              name: "noop",
              description: "Fixture",
              parameters: { type: "object", properties: {} },
            },
            async () => ({ ok: true, content: "Observed" }),
          ),
        ],
        onEvent: (event) => events.push(event),
      },
    );
    assert.equal(
      events.some(
        (event) => event.type === "advisory" && event.kind === "verbose_turn",
      ),
      !hidden,
    );
  }
});

test("custom schema tool validates inputs and bounds its output", async () => {
  const { makeSearchCatalogTool } = await loadCode(
    namedCode("customToolExample"),
  );
  let received;
  const tool = makeSearchCatalogTool(async (input) => {
    received = input;
    return [{ id: 1 }];
  });
  const good = await tool.run({ query: " docs ", limit: 2 }, {});
  assert.equal(good.ok, true);
  assert.deepEqual(received, { query: "docs", limit: 2 });
  for (const input of [
    { query: "" },
    { query: "docs", limit: "2" },
    { query: "docs", limit: 11 },
    { query: "docs", extra: true },
  ])
    assert.equal((await tool.run(input, {})).ok, false);
  const large = makeSearchCatalogTool(async () => [
    { text: "x".repeat(30_000) },
  ]);
  const clipped = await large.run({ query: "docs" }, {});
  assert.ok(clipped.content.length < 8_500);
  assert.equal(clipped.meta.count, 1);
});

test("same-process revival example funds a second run and cleans up once", async () => {
  const { runWithRevival } = await loadCode(namedCode("revivalLoopExample"));
  let calls = 0,
    starts = 0,
    destroys = 0;
  const sandbox = {
    id: "fixture",
    backend: "fixture",
    workspace: "/repo",
    scratch: "/scratch",
    async start() {
      starts++;
    },
    async destroy() {
      destroys++;
    },
    async hasChangesFrom() {
      return false;
    },
    async exec() {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        output: "",
        timedOut: false,
        durationMs: 0,
      };
    },
  };
  const llm = {
    model: "scripted-docs-test",
    async complete(request, options) {
      return this.stream(request, () => {}, options);
    },
    async stream() {
      calls++;
      return {
        text: "",
        model: this.model,
        latencyMs: 0,
        toolCalls: [
          {
            id: "call-" + calls,
            name: calls === 1 ? "request_revival" : "finish",
            arguments:
              calls === 1
                ? '{"remaining":"Check the final result"}'
                : '{"summary":"Done"}',
          },
        ],
        usage: {
          promptTokens: calls === 1 ? 3_100_000 : 10,
          completionTokens: 10,
          totalTokens: calls === 1 ? 3_100_010 : 20,
          costUsd: 0.1,
        },
      };
    },
  };
  const outcome = await runWithRevival({
    llm,
    provider: { create: () => sandbox },
    repoUrl: "https://example.invalid/repo",
    task: "Fixture task",
  });
  assert.equal(calls, 2);
  assert.equal(starts, 1);
  assert.equal(destroys, 1);
  assert.equal(outcome.result.reason, "finished");
});

test("trace sink receives detailed sequenced records and replayable content", async () => {
  const code = namedCode("sinkExample").split("// Your app must implement")[0];
  const { databaseTraceSink } = await loadCode(code);
  const directory = await mkdtemp(join(os.tmpdir(), "anchor-docs-trace-"));
  try {
    const trace = new sdk.JsonlTrace(join(directory, "trace.ndjson"));
    const saved = [],
      raw = [],
      frames = [];
    let calls = 0;
    const llm = {
      model: "scripted-docs-test",
      async complete(request, options) {
        return this.stream(request, () => {}, options);
      },
      async stream(request, delta) {
        calls++;
        const text = calls === 1 ? "Checking." : "Done.";
        delta(text);
        return {
          text,
          model: this.model,
          latencyMs: 0,
          toolCalls: [
            {
              id: "call-" + calls,
              name: calls === 1 ? "fixture_tool" : "finish",
              arguments: calls === 1 ? "{}" : '{"summary":"Done"}',
            },
          ],
          usage: {
            promptTokens: 10,
            completionTokens: 10,
            totalTokens: 20,
            costUsd: 0.1,
          },
        };
      },
    };
    await sdk.runAgent(
      { task: "Audit sk-fixturesecret12345678" },
      {
        llm,
        agent: sdk.chatAgent,
        snapshot: false,
        tools: [
          sdk.defineTool(
            {
              name: "fixture_tool",
              description: "Fixture",
              parameters: { type: "object", properties: {} },
            },
            async () => ({
              ok: true,
              content: "Observed result",
              meta: { count: 1 },
            }),
          ),
        ],
        onEvent: (event) => raw.push(event),
        traceSinks: [
          trace,
          databaseTraceSink("run-1", async (row) => saved.push(row)),
          sdk.createLiveProjector((frame) => frames.push(frame)),
        ],
      },
    );
    const entries = (await readFile(trace.filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries.length, saved.length);
    assert.ok(
      raw
        .find((event) => event.type === "run_started")
        .task.includes("sk-fixturesecret12345678"),
    );
    assert.ok(
      entries
        .find((entry) => entry.event.type === "run_started")
        .event.task.includes("[REDACTED]"),
    );
    const result = entries.find(
      (entry) =>
        entry.event.type === "tool_result" &&
        entry.event.name === "fixture_tool",
    );
    assert.equal(result.event.content, "Observed result");
    assert.equal(result.event.meta.count, 1);
    assert.ok(
      entries.some(
        (entry) =>
          entry.event.type === "llm_call_finished" &&
          entry.event.toolCalls.length,
      ),
    );
    assert.ok(frames.some((frame) => frame.kind === "assistant_done"));
    assert.ok(
      sdk
        .projectConversation(
          entries.map(({ seq, event }) => ({
            seq,
            type: event.type,
            payload: event,
          })),
          "finished",
        )
        .parts.some((part) => part.name === "fixture_tool"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
