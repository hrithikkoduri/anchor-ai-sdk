/**
 * A non-coding agent — the proof that Anchor is an agent harness SDK, not a
 * coding tool.
 *
 *   OPENROUTER_KEY=... node examples/repo-triage.mjs README.md
 *
 * Everything here is the consumer's: the strategy (its own system prompt and
 * phases), the tool (plain Node code — no sandbox), and the report format.
 * Everything the harness provides still applies: the loop, required-tool
 * validation, budgets, trace sinks, and the honest stop.
 */
import { readFile } from "node:fs/promises";
import {
  defineTool,
  JsonlTrace,
  llmFromCatalog,
  runAgent,
} from "anchor-ai-sdk";

const target = process.argv[2] ?? "README.md";

/** The one tool this agent gets — plain code, no execution environment. */
const wordCounts = defineTool(
  {
    name: "word_counts",
    description: "Return the ten most frequent words in the file under analysis.",
    parameters: { type: "object", properties: {} },
  },
  async () => {
    const text = await readFile(target, "utf8");
    const counts = new Map();
    for (const word of text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10);
    return {
      ok: true,
      content: top.map(([word, n]) => `${word}: ${n}`).join("\n"),
    };
  },
);

/** The consumer's strategy: what this agent is, and the approach it takes. */
const triageStrategy = {
  name: "triage",
  phases: [
    { id: "measure", goal: "collect hard numbers with word_counts" },
    { id: "advise", goal: "state what the numbers mean — and what they do not" },
  ],
  systemPrompt({ task, summary }) {
    return [
      "You are a precise editorial analyst.",
      "Call word_counts before drawing any conclusion; it is the only evidence you have.",
      "Report only what the tool observed. Mark anything unmeasured as a hypothesis.",
      `Task: ${task}`,
      summary ? `\n# Earlier context on this thread\n${summary}` : "",
    ]
      .join("\n")
      .trim();
  },
  requiredTools: ["word_counts"],
};

const apiKey = process.env.OPENROUTER_KEY;
if (!apiKey) {
  console.error("Set OPENROUTER_KEY (any OpenAI-compatible provider works).");
  process.exit(1);
}
const { llm } = await llmFromCatalog({
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey,
  model: process.env.MODEL ?? "z-ai/glm-5.3",
});

// Every event, redacted once, in one replayable file — with the same sequence
// number any other sink would see.
const trace = new JsonlTrace("./triage-trace.jsonl");

const result = await runAgent(
  { task: `Analyze ${target}: what is it about, per the word counts?` },
  {
    llm,
    strategy: triageStrategy,
    tools: [wordCounts],
    traceSinks: [trace],
    budgets: { maxSteps: 8, maxUsd: 0.25 },
  },
);

console.log(`\n${result.summary ?? "(no summary)"}\n`);
console.log(`trace: ${trace.filePath} (${trace.length} events)`);
