/**
 * The harness benchmark CLI.
 *
 *   npm run eval --prefix evals -- --tasks benchmarks/swe-bench/data/swebench-lite-10.jsonl --provider docker --model z-ai/glm-5.3
 *
 * No product stack behind it: no worker, no queue, no webhook, no database.
 * The app imports `anchor-ai-sdk` directly — plus exactly one thing from the
 * Zero product imports: config comes from this app's own reader, the runtime
 * is pure Anchor. The app moves with the package to its own repo.
 *
 * Outputs (in `--out`, default `.eval-runs/<timestamp>/`):
 *   predictions.jsonl  official-grader input: instance_id, model_patch
 *   results.jsonl      our record: status, steps, usage, cost, wall time
 *   run.json           the run's configuration and summary
 *   traces/<id>.jsonl  every engine event of the task
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { llmFromCatalog, type BudgetLimits } from "anchor-ai-sdk";
import { local } from "anchor-ai-sdk/sandbox/local";
import { heyo } from "anchor-ai-sdk/sandbox/heyo";
import { docker } from "anchor-ai-sdk/sandbox/docker";
import { anchorArm } from "./arms/anchor.js";
import { evalsConfig, loadDotEnv } from "./config.js";
import { miniSweArm } from "./arms/mini-swe.js";
import { loadTasks, type EvalTask } from "./tasks.js";
import { runEvalSuite, type EvalTaskResult } from "./runner.js";

const USAGE = `usage: eval --tasks <file.jsonl> [options]
  --provider local|heyo|docker  sandbox backend (default local; docker = the
                          benchmark environment from task images; heyo = VMs)
  --arm anchor|mini       system under test (default anchor)
  --limit <n>             run only the first n tasks
  --task <instance_id>    run a single task
  --model <id>            model override (default: configured LLM)
  --llm openrouter|parasail
                          which API to call (default openrouter). parasail
                          reads PARASAIL_API_KEY and pins temperature 0, seed 42
  --temperature <n>       sampling temperature (parasail default 0)
  --seed <n>              sampling seed (parasail default 42)
  --max-steps <n>         budget: steps per task (engine default 40)
  --max-usd <n>           budget: dollars per task (engine default 5)
  --image-tag <tag>       boot task images as <repo>:<tag> (prewarmed)
  --out <dir>             output directory (default .eval-runs/<timestamp>)`;

function parseArgs(argv: string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const [key, inline] = token.slice(2).split("=", 2);
    if (key === undefined) continue;
    if (inline !== undefined) {
      args.set(key, inline);
    } else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      args.set(key, argv[i + 1]!);
      i++;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

function say(line: string): void {
  process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.has("help") || !args.has("tasks")) {
  say(USAGE);
  process.exit(args.has("help") ? 0 : 1);
}

const tasksFile = String(args.get("tasks"));
const armName = String(args.get("arm") ?? "anchor");
if (armName !== "anchor" && armName !== "mini") {
  say(`unknown arm "${armName}" — anchor or mini`);
  process.exit(1);
}
const providerName = String(args.get("provider") ?? "local");
if (
  providerName !== "local" &&
  providerName !== "heyo" &&
  providerName !== "docker"
) {
  say(`unknown provider "${providerName}" — local, heyo, or docker`);
  process.exit(1);
}

loadDotEnv();
const cfg = evalsConfig();
const llmName = String(args.get("llm") ?? "openrouter");
if (llmName !== "openrouter" && llmName !== "parasail") {
  say(`unknown llm "${llmName}" — openrouter or parasail`);
  process.exit(1);
}
const parasail = llmName === "parasail";
const model = String(
  args.get("model") ?? (parasail ? "zai-org/GLM-5.3" : cfg.llm.model),
);
const baseUrl = parasail ? "https://api.parasail.io/v1" : cfg.llm.baseUrl;
const apiKey = parasail
  ? process.env.PARASAIL_API_KEY || undefined
  : cfg.llm.apiKey;
if (parasail && !apiKey) {
  say("PARASAIL_API_KEY is not set — add it to .env (do not commit it)");
  process.exit(1);
}
const temperature = args.has("temperature")
  ? Number(args.get("temperature"))
  : parasail
    ? 0
    : undefined;
const seed = args.has("seed")
  ? Number(args.get("seed"))
  : parasail
    ? 42
    : undefined;
if (
  (temperature !== undefined && !Number.isFinite(temperature)) ||
  (seed !== undefined && !Number.isInteger(seed))
) {
  say("--temperature must be a number and --seed an integer");
  process.exit(1);
}
const sampling =
  temperature !== undefined || seed !== undefined
    ? {
        ...(temperature !== undefined ? { temperature } : {}),
        ...(seed !== undefined ? { seed } : {}),
      }
    : undefined;

// The model's real catalog entry prices the run and sizes compaction, exactly
// as the product does — the eval must not run a differently-configured engine.
// No price overrides on purpose: the CATALOG is the truth (live provider
// rates); .env prices are known-stale and would silently misprice a round
// (2026-10-18: 2x/10x off for GLM 5.3). Catalog unreachable → cost reads as
// unknown rather than wrong.
const { llm, catalog, compaction } = await llmFromCatalog({
  baseUrl,
  apiKey,
  model,
  // Published Parasail rates. Their catalog may not match the OpenRouter
  // price shape, and an unpriced run hides a bad trajectory. OpenRouter
  // keeps its live catalog prices.
  ...(parasail
    ? {
        priceInPerMTok: 1.4,
        priceOutPerMTok: 4.4,
        priceCacheReadPerMTok: 0.26,
      }
    : {}),
});
const provider =
  providerName === "heyo"
    ? heyo(cfg.heyo)
    : providerName === "docker"
      ? docker({ dockerBin: process.env.DOCKER_BIN ?? "docker" })
      : local();

// Mini has no token cap (250 steps, $3). 50M is this eval's fair ceiling,
// not the package default. A flag still wins.
const budgets: Partial<BudgetLimits> = { maxTokens: 50_000_000 };
if (args.has("max-steps")) budgets.maxSteps = Number(args.get("max-steps"));
if (args.has("max-usd")) budgets.maxUsd = Number(args.get("max-usd"));
if (args.has("max-tokens")) budgets.maxTokens = Number(args.get("max-tokens"));

let tasks: EvalTask[] = await loadTasks(tasksFile);
if (args.has("task")) {
  const wanted = String(args.get("task"));
  tasks = tasks.filter((task) => task.id === wanted);
}
if (args.has("limit")) tasks = tasks.slice(0, Number(args.get("limit")));
if (args.has("image-tag")) {
  const tag = String(args.get("image-tag"));
  tasks = tasks.map((task) =>
    task.image
      ? { ...task, image: task.image.replace(/:[^:/]+$/, `:${tag}`) }
      : task,
  );
}
if (tasks.length === 0) {
  say(`no tasks matched in ${tasksFile}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = String(args.get("out") ?? path.join(".eval-runs", stamp));
const tracesDir = path.join(outDir, "traces");
await mkdir(tracesDir, { recursive: true });
const artifactsDir = path.join(outDir, "artifacts");
await mkdir(artifactsDir, { recursive: true });
// Slash-free: the official grader uses this as a filename component.
const modelLabel = `${armName}@${model.replaceAll("/", "-")}`;
const startedAt = Date.now();

say(
  `anchor eval · ${armName}@${model} · ${llmName} · ${provider.name} · ${tasks.length} task(s)`,
);
// The anchor arm pins sampling through the engine. Mini brings its own loop
// and its own sampling defaults, so this line must not claim otherwise.
if (sampling && armName === "anchor") {
  say(
    `sampling: temperature ${sampling.temperature ?? "unset"} · seed ${sampling.seed ?? "unset"}`,
  );
}
if (armName === "mini") {
  say(
    sampling
      ? `sampling: pinned through litellm — temperature ${sampling.temperature ?? "unset"} · seed ${sampling.seed ?? "unset"}`
      : "sampling: mini's own defaults",
  );
}
say(
  `model: ${catalog ? `${catalog.contextLength ?? "?"}-token window` : "catalog unreachable"}`,
);
say(`out:   ${outDir}`);

// Traces are collected per task and flushed when the task finishes — no
// interleaving, and a task's events survive even if a later task crashes.
const traces = new Map<string, string[]>();
const flushTrace = async (taskId: string): Promise<void> => {
  const chunks = traces.get(taskId);
  if (!chunks || chunks.length === 0) return;
  await writeFile(path.join(tracesDir, `${taskId}.jsonl`), chunks.join(""));
};

const fmtUsd = (value: number | undefined) =>
  value === undefined ? "—" : `$${value.toFixed(4)}`;
const fmtWall = (ms: number) => {
  const secs = Math.round(ms / 1000);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
};

const report = (result: EvalTaskResult, index: number): void => {
  const usage = result.usage;
  const tokens =
    usage === undefined
      ? "—"
      : `${Math.round((usage.promptTokens + usage.completionTokens) / 1000)}k`;
  const mark = result.status === "completed" ? "✓" : "✗";
  const detail =
    result.status === "completed"
      ? `${result.steps ?? "?"} steps · ${tokens} tok · ${fmtUsd(usage?.costUsd)}`
      : `${result.error ?? "failed"}`;
  say(
    `[${index + 1}/${tasks.length}] ${result.taskId} ${mark} ${detail} · ${fmtWall(result.wallMs)}`,
  );
};

// Mini reaches the model through litellm: `openrouter/x` for the gateway,
// `openai/x` plus a base URL for a direct OpenAI-compatible endpoint.
const modelRef =
  parasail
    ? `openai/${model}`
    : model.startsWith("openrouter/")
      ? model
      : `openrouter/${model}`;
const arm =
  armName === "mini"
    ? miniSweArm({
        model: modelRef,
        dockerBin: process.env.DOCKER_BIN ?? "docker",
        ...(parasail
          ? { baseUrl, ...(apiKey ? { apiKey } : {}) }
          : cfg.llm.apiKey
            ? { apiKey: cfg.llm.apiKey }
            : {}),
        ...(sampling ? { sampling } : {}),
        ...(args.has("max-usd")
          ? { costLimitUsd: Number(args.get("max-usd")) }
          : {}),
      })
    : anchorArm();

let finished = 0;

const results = await runEvalSuite({
  tasks,
  arm,
  provider,
  llm,
  ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
  ...(compaction ? { compaction } : {}),
  ...(sampling ? { sampling } : {}),
  artifactsDir,
  onEvent: (task, event) => {
    const chunks = traces.get(task.id) ?? [];
    chunks.push(`${JSON.stringify({ at: Date.now(), ...event })}\n`);
    traces.set(task.id, chunks);
  },
  onResult: async (result) => {
    await flushTrace(result.taskId);
    await appendFile(
      path.join(outDir, "predictions.jsonl"),
      `${JSON.stringify({
        instance_id: result.taskId,
        model_name_or_path: modelLabel,
        model_patch: result.patch,
      })}\n`,
    );
    await appendFile(
      path.join(outDir, "results.jsonl"),
      `${JSON.stringify({
        taskId: result.taskId,
        arm: result.arm,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
        ...(result.steps !== undefined ? { steps: result.steps } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        wallMs: result.wallMs,
        patchChars: result.patch.length,
      })}\n`,
    );
    report(result, finished++);
  },
  log: (line) => say(line),
});

const completed = results.filter(
  (result) => result.status === "completed",
).length;
const totalUsd = results.reduce(
  (sum, result) => sum + (result.usage?.costUsd ?? 0),
  0,
);
const walls = results.map((result) => result.wallMs).sort((a, b) => a - b);
const percentile = (fraction: number): number | undefined =>
  walls.length === 0
    ? undefined
    : walls[Math.min(walls.length - 1, Math.floor(fraction * walls.length))];

await writeFile(
  path.join(outDir, "run.json"),
  `${JSON.stringify(
    {
      arm: armName,
      model,
      llm: llmName,
      baseUrl,
      ...(sampling ? { sampling } : {}),
      provider: provider.name,
      tasks: tasks.length,
      completed,
      failed: tasks.length - completed,
      totalUsd,
      wallMsP50: percentile(0.5),
      wallMsP95: percentile(0.95),
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      budgets,
      contextWindow: catalog?.contextLength ?? null,
    },
    null,
    2,
  )}\n`,
);

say("");
say(
  `done: ${completed}/${tasks.length} completed · ${fmtUsd(totalUsd)} total · ` +
    `p50 ${fmtWall(percentile(0.5) ?? 0)} · p95 ${fmtWall(percentile(0.95) ?? 0)}`,
);
say(`predictions: ${path.join(outDir, "predictions.jsonl")}`);
say("next: grade with the official swebench harness (Docker)");
