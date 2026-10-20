import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// Use a compiled SDK, not a mocked module. No provider/network calls are made.
const entry = pathToFileURL(
  process.env.ANCHOR_SDK_ENTRY ??
    fileURLToPath(new URL("../../dist/index.js", import.meta.url)),
).href;
const { runAgent } = await import(entry);
const source = await readFile(
  new URL("../src/examples/policy-agent.mjs", import.meta.url),
  "utf8",
);
const module = await import(
  `data:text/javascript;base64,${Buffer.from(source.replace('"anchor-ai-sdk"', JSON.stringify(entry))).toString("base64")}`
);
const { lookupPolicy, policyAgent, policyStrategy } = module;

test("the example handles valid, unknown, and invalid input", async () => {
  const valid = await lookupPolicy.run({ topic: " refunds " }, {});
  assert.equal(valid.ok, true);
  assert.match(valid.content, /30 days/);
  assert.deepEqual(valid.meta, { topic: "refunds", source: "demo-policies" });
  assert.equal(
    (await lookupPolicy.run({ topic: "not-a-policy" }, {})).ok,
    false,
  );
  const invalid = await lookupPolicy.run({ topic: 42 }, {});
  assert.equal(invalid.ok, false);
  assert.match(invalid.content, /non-empty string/);
});

function scriptedModel() {
  const requests = [];
  const calls = [
    { name: "lookup_policy", arguments: '{"topic":"refunds"}' },
    { name: "set_phase", arguments: '{"phase":"answer"}' },
    {
      name: "finish",
      arguments:
        '{"summary":"Refunds: within 30 days, with the original receipt."}',
    },
  ];
  return {
    model: "scripted-docs-test",
    requests,
    async complete(req, opts) {
      return this.stream(req, () => {}, opts);
    },
    async stream(req) {
      requests.push(structuredClone(req));
      const next = calls.shift();
      assert.ok(next, "The example should finish in three model calls");
      return {
        text: "",
        toolCalls: [{ id: `call-${requests.length}`, ...next }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: this.model,
        latencyMs: 0,
      };
    },
  };
}

for (const bundled of [true, false]) {
  test(`the real SDK executes ${bundled ? "the agent bundle" : "separate strategy and tools"}`, async () => {
    const llm = scriptedModel();
    const result = await runAgent(
      { task: "What is the refund policy?" },
      {
        llm,
        ...(bundled
          ? { agent: policyAgent }
          : { strategy: policyStrategy, tools: [lookupPolicy] }),
        budgets: { maxSteps: 5 },
        compaction: false,
      },
    );
    assert.equal(result.reason, "finished");
    assert.equal(result.completion, "declared");
    assert.equal(result.phase, "answer");
    assert.match(result.summary, /30 days/);
    assert.ok(
      result.evidence.some((item) => item.tool === "lookup_policy" && item.ok),
    );
    assert.ok(
      llm.requests[1].messages.some(
        (message) =>
          message.role === "tool" && message.content.includes("30 days"),
      ),
    );
  });
}

test("required tools are validated before model execution", async () => {
  const llm = scriptedModel();
  await assert.rejects(
    runAgent(
      { task: "What is the refund policy?" },
      { llm, strategy: policyStrategy, tools: [] },
    ),
    /lookup_policy/,
  );
  assert.equal(llm.requests.length, 0);
});
