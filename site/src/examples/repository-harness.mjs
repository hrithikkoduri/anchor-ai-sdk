import { pathToFileURL } from "node:url";
import {
  bashTool,
  readFileTool,
  searchTool,
  runTestsTool,
  llmFromCatalog,
  runAgent,
  MemoryThreadStore,
  MemoryInboxStore,
  JsonlTrace,
} from "anchor-ai-sdk";

// 01 / PHASES — a vocabulary for the work, not an enforced state machine.
export const reviewPhases = [
  { id: "understand", goal: "Locate the code relevant to the question." },
  { id: "inspect", goal: "Read the implementation and investigate the behavior." },
  { id: "validate", goal: "Run relevant checks and record their actual outcome." },
  { id: "respond", goal: "Explain findings, evidence, and anything unverified." },
];

// 02 / STRATEGY — prompt + phase data + startup requirements.
export const reviewStrategy = {
  name: "repository-review",
  phases: reviewPhases,
  requiresSandbox: true,
  requiredTools: ["read_file", "search", "bash", "run_tests"],
  systemPrompt({ context, summary }) {
    return [
      "You investigate repository behavior. Do not intentionally edit project files.",
      "Use search to locate code and read_file to inspect it. Cite paths in findings.",
      "Use run_tests for relevant checks. Do not present unrun checks as passing.",
      "Use set_phase when the approach changes; phases may be skipped or revisited.",
      "Conclude with finish: report findings, observed checks, and remaining uncertainty.",
      ...reviewPhases.map(phase => `${phase.id}: ${phase.goal}`),
      context ? `Application context: ${context}` : "",
      summary ? `Earlier thread summary: ${summary}` : "",
    ].filter(Boolean).join("\n");
  },
};

// 03 / AGENT — capabilities and behavior, without a model or machine instance.
export const reviewAgent = {
  name: "repository-reviewer",
  strategy: reviewStrategy,
  tools: [readFileTool, searchTool, bashTool, runTestsTool()],
};

// 04 / HARNESS — the host owns resources; runAgent owns the model/tool loop.
export async function reviewRepository({
  llm, compaction, provider, repoUrl, ref = "main", task, context,
  threadId, threadStore, inboxStore, traceSinks = [], signal, onEvent,
}) {
  const sandbox = provider.create({ repoUrl, ref });
  try {
    await sandbox.start();
    const result = await runAgent({ task, context }, {
      llm, compaction, agent: reviewAgent, sandbox, signal,
      budgets: { maxSteps: 40, maxTokens: 3_000_000, maxUsd: 2 },
      guardrails: { repeatedToolCallLimit: 3, toolOnlyNudgeLimit: 8 },
      thread: { store: threadStore, id: threadId },
      inbox: { store: inboxStore, channel: threadId },
      traceSinks, onEvent,
      // Deliberately synchronous: background execution needs retention/resume
      // bookkeeping, rather than adding a threshold to a disposable workspace.
    });
    return {
      result,
      // A completed loop is not proof of correctness. Host policy decides what
      // evidence is sufficient; no publish/deploy operation is in this tool set.
      observedChecks: result.evidence.filter(item => item.tool === "run_tests"),
    };
  } finally {
    await sandbox.destroy();
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error("Set " + name + " before running this example.");
  return value;
}

// 05 / BOOT — real provider configuration, then the same composed harness.
export async function main() {
  const { heyo } = await import("anchor-ai-sdk/sandbox/heyo");
  const provider = heyo({
    token: requiredEnv("HEYO_TOKEN"),
    server: requiredEnv("HEYO_SERVER"),
    namespace: requiredEnv("HEYO_NAMESPACE"),
    image: requiredEnv("HEYO_IMAGE"),
    imageKind: "artifact",
    imageStore: requiredEnv("HEYO_IMAGE_STORE"),
    sizeClass: "small",
    diskSizeGb: 10,
  });
  const { llm, compaction } = await llmFromCatalog({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: requiredEnv("OPENROUTER_KEY"),
    model: process.env.MODEL ?? "z-ai/glm-5.3",
  });
  // Allocate once per worker/session; replace these with durable adapters for
  // cross-process use. Keep one active chain per thread/workspace in your host.
  const threadStore = new MemoryThreadStore();
  const inboxStore = new MemoryInboxStore();
  const threadId = "repository-review-demo";
  const { result, observedChecks } = await reviewRepository({
    llm, compaction, provider,
    repoUrl: requiredEnv("REPO_URL"),
    ref: process.env.REPO_REF ?? "main",
    task: process.env.TASK ?? "Explain this repository's main execution path and run relevant checks.",
    threadId, threadStore, inboxStore,
    traceSinks: [new JsonlTrace("./traces/review-" + Date.now() + ".ndjson")],
    onEvent(event) {
      if (event.type === "phase_started") console.error("phase:", event.phase);
    },
  });
  console.log(result.summary ?? result.error ?? result.reason);
  console.log("chain usage:", result.usage, "per-run summaries:", result.runs);
  console.log("final-run checks:", observedChecks);
  return result;
}

// Safe to import; only running this file boots a machine and calls the model.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
