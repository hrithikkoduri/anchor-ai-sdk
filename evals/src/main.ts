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
  --provider local|heyo|docker|e2b  sandbox backend (default local; docker = the
                          benchmark environment from task images; heyo/e2b = VMs)
  --e2b-template <name>   override E2B_TEMPLATE for repo-clone tasks
  --arm anchor|mini       system under test (default anchor)
  --variant <name>        harness variant recorded with the run (default baseline)
  --reasoning <effort>    minimal|low|medium|high|xhigh|max (anchor arm only)
  --task-image            heyo: boot the task's own image (no repo clone)
  --time-budget <secs>    wall-clock ceiling per task (checks still run)
  --repeat <n>            repeat each harness task n times (n>1 needs checks)
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
  --egress none           cut the sandbox network after setup (docker only);
                          without it the agent can fetch the upstream fix
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
const variant = String(args.get("variant") ?? "baseline");
const armName = String(args.get("arm") ?? "anchor");
const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const reasoningArg = args.has("reasoning")
  ? String(args.get("reasoning"))
  : undefined;
if (
  reasoningArg !== undefined &&
  !REASONING_EFFORTS.includes(
    reasoningArg as (typeof REASONING_EFFORTS)[number],
  )
) {
  say(`unknown reasoning effort "${reasoningArg}" — ${REASONING_EFFORTS.join(", ")}`);
  process.exit(1);
}
const reasoningEffort = reasoningArg as
  | (typeof REASONING_EFFORTS)[number]
  | undefined;
const timeBudgetSecs = args.has("time-budget")
  ? Number(args.get("time-budget"))
  : undefined;
if (
  timeBudgetSecs !== undefined &&
  (!Number.isFinite(timeBudgetSecs) || timeBudgetSecs <= 0)
) {
  say("--time-budget must be a positive number of seconds");
  process.exit(1);
}
if (armName !== "anchor" && armName !== "mini") {
  say(`unknown arm "${armName}" — anchor or mini`);
  process.exit(1);
}
const providerName = String(args.get("provider") ?? "local");
if (
  providerName !== "local" &&
  providerName !== "heyo" &&
  providerName !== "docker" &&
  providerName !== "e2b"
) {
  say(`unknown provider "${providerName}" — local, heyo, docker, or e2b`);
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
// Egress is a benchmark control, not a product default: it is how a run stops
// being able to fetch the answer. Only a provider that declares the capability
// may accept it; the rest would silently run with network.
const egress = args.has("egress")
  ? String(args.get("egress"))
  : undefined;
if (egress !== undefined && egress !== "none") {
  say(`--egress takes "none" (the full-network default needs no flag)`);
  process.exit(1);
}
if (egress === "none" && providerName !== "docker") {
  say(
    `--egress none needs the docker provider (egressControl); ${providerName} cannot enforce it`,
  );
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
const e2bTemplate = args.has("e2b-template")
  ? String(args.get("e2b-template"))
  : cfg.e2b.template;
const provider =
  providerName === "heyo"
    ? heyo(cfg.heyo)
    : providerName === "docker"
      ? docker({ dockerBin: process.env.DOCKER_BIN ?? "docker" })
      : providerName === "e2b"
        ? // Optional provider: imported only when asked for, so a docker or
          // local run never needs the `e2b` package installed.
          await import("anchor-ai-sdk/sandbox/e2b").then(({ e2b }) =>
            e2b({
              apiKey: cfg.e2b.apiKey,
              template: e2bTemplate,
              user: cfg.e2b.user,
              timeoutMs: cfg.e2b.timeoutMs,
            }),
          )
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
if (args.has("repeat")) {
  const repeat = Number(args.get("repeat"));
  if (!Number.isInteger(repeat) || repeat < 1) {
    say("--repeat must be a positive integer");
    process.exit(1);
  }
  if (repeat > 1) {
    if (!tasks.every((task) => task.checks?.length)) {
      say("--repeat needs harness tasks with checks (no external grader)");
      process.exit(1);
    }
    tasks = tasks.flatMap((task) =>
      Array.from({ length: repeat }, (_, index) => ({
        ...task,
        id: `${task.id}__r${index + 1}`,
      })),
    );
  }
}
if (args.has("image-tag")) {
  const tag = String(args.get("image-tag"));
  tasks = tasks.map((task) =>
    task.image
      ? { ...task, image: task.image.replace(/:[^:/]+$/, `:${tag}`) }
      : task,
  );
}
if (providerName === "heyo" && args.has("task-image")) {
  // The provider boots this task's own image (built from the official task
  // image). The repo is already provisioned at workspacePath; never clone.
  tasks = tasks.map((task) => {
    const {
      image: _image,
      repoUrl: _repoUrl,
      baseRef: _baseRef,
      setup: _setup,
      ...rest
    } = task;
    const checks =
      task.checks ??
      task.failToPass?.map((test) => ({
        id: test,
        command: `python -m pytest -q ${JSON.stringify(test)}`,
      }));
    return {
      ...rest,
      workspacePath: task.workspacePath ?? "/testbed",
      ...(checks && checks.length > 0 ? { checks } : {}),
    };
  });
} else if (providerName === "heyo") {
  // Generic image: clone the task repo at its base commit and install the
  // project. This is only an approximation; old SWE-bench repos need their
  // official image (use --task-image with a per-task build).
  tasks = tasks.map((task) => {
    const { image, workspacePath: _workspacePath, ...rest } = task;
    const setup =
      rest.setup ??
      (image !== undefined ? ["python3 -m pip install -e ."] : undefined);
    const checks =
      rest.checks ??
      task.failToPass?.map((test) => ({
        id: test,
        command: `python3 -m pytest -q ${JSON.stringify(test)}`,
      }));
    return {
      ...rest,
      ...(setup && setup.length > 0 ? { setup } : {}),
      ...(checks && checks.length > 0 ? { checks } : {}),
    };
  });
}

if (providerName === "e2b") {
  // The task's `image` is a Docker image from the SWE-bench dataset. E2B boots
  // templates instead, so each image task needs an explicit mapping (built
  // with `Template().fromImage(...)`), while repo-clone tasks use the default
  // template.
  const templateFor = (task: EvalTask): string => {
    const mapped =
      cfg.e2b.templateMap[task.id] ??
      (task.image ? cfg.e2b.templateMap[task.image] : undefined);
    if (mapped) return mapped;
    if (!task.image) return e2bTemplate;
    throw new Error(
      `E2B has no template for ${task.id} (${task.image}). ` +
        `Build one from the image and add it to E2B_TEMPLATE_MAP ` +
        `(keyed by instance id or image).`,
    );
  };
  tasks = tasks.map((task) =>
    task.image ? { ...task, image: templateFor(task) } : task,
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
  const mark =
    result.status === "completed"
      ? result.falseFinish
        ? "!"
        : "✓"
      : result.status === "timeout"
        ? "⏱"
        : "✗";
  const scored =
    result.reward === undefined
      ? ""
      : ` · reward ${result.reward.toFixed(2)}${result.checks ? ` (${result.checks.filter((check) => check.ok).length}/${result.checks.length})` : ""}`;
  const detail =
    result.status === "completed" || result.status === "timeout"
      ? `${result.steps ?? "?"} steps · ${tokens} tok · ${fmtUsd(usage?.costUsd)}${scored}`
      : `${result.error ?? "failed"}${scored}`;
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
    : anchorArm({
        variant,
        ...(reasoningEffort ? { engineOptions: { reasoningEffort } } : {}),
      });

let finished = 0;
/** Tool calls per task — the mechanism-activation signal. */
const toolCounts = new Map<string, Record<string, number>>();

const results = await runEvalSuite({
  tasks,
  arm,
  provider,
  llm,
  ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
  ...(compaction ? { compaction } : {}),
  ...(sampling ? { sampling } : {}),
  ...(egress ? { egress: egress as "none" } : {}),
  ...(timeBudgetSecs !== undefined ? { timeBudgetSecs } : {}),
  variant,
  artifactsDir,
  onEvent: (task, event) => {
    const chunks = traces.get(task.id) ?? [];
    chunks.push(`${JSON.stringify({ at: Date.now(), ...event })}\n`);
    traces.set(task.id, chunks);
    if (event.type === "tool_call") {
      const counts = toolCounts.get(task.id) ?? {};
      counts[event.name] = (counts[event.name] ?? 0) + 1;
      toolCounts.set(task.id, counts);
    }
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
        ...(result.variant ? { variant: result.variant } : {}),
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
        ...(result.steps !== undefined ? { steps: result.steps } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.reward !== undefined ? { reward: result.reward } : {}),
        ...(result.checks
          ? {
              checks: result.checks.map((check) => ({
                id: check.id,
                ok: check.ok,
                weight: check.weight,
                exitCode: check.exitCode,
                output: check.output.slice(0, 500),
              })),
            }
          : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.falseFinish ? { falseFinish: true } : {}),
        ...(toolCounts.get(result.taskId)
          ? { toolCalls: toolCounts.get(result.taskId) }
          : {}),
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
const scored = results.filter((result) => result.reward !== undefined);
const fullCredit = scored.filter((result) => (result.reward ?? 0) >= 0.95).length;
const meanReward =
  scored.length === 0
    ? undefined
    : scored.reduce((sum, result) => sum + (result.reward ?? 0), 0) /
      scored.length;
const falseFinishes = results.filter((result) => result.falseFinish).length;
const timeouts = results.filter((result) => result.status === "timeout").length;
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
      variant,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      model,
      llm: llmName,
      baseUrl,
      ...(args.has("repeat") ? { repeat: Number(args.get("repeat")) } : {}),
      ...(timeBudgetSecs !== undefined ? { timeBudgetSecs } : {}),
      ...(sampling ? { sampling } : {}),
      ...(egress ? { egress } : {}),
      provider: provider.name,
      ...(providerName === "heyo"
        ? { grader: "pytest-fail-to-pass (local approximation, not official)" }
        : {}),
      ...(providerName === "e2b"
        ? {
            e2b: {
              template: e2bTemplate,
              user: cfg.e2b.user ?? null,
              templateMap: cfg.e2b.templateMap,
            },
          }
        : {}),
      tasks: tasks.length,
      completed,
      failed: tasks.length - completed,
      ...(scored.length > 0
        ? {
            fullCredit,
            meanReward,
            falseFinishes,
            timeouts,
            checksPassed: scored.reduce(
              (sum, result) =>
                sum + (result.checks?.filter((check) => check.ok).length ?? 0),
              0,
            ),
            checksTotal: scored.reduce(
              (sum, result) => sum + (result.checks?.length ?? 0),
              0,
            ),
          }
        : {}),
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
if (scored.length > 0) {
  say(
    `scored: ${fullCredit}/${scored.length} full credit · mean reward ${
      meanReward?.toFixed(3) ?? "—"
    } · ${falseFinishes} false finish(es) · ${timeouts} timeout(s)`,
  );
}
say(`predictions: ${path.join(outDir, "predictions.jsonl")}`);
say("next: grade with the official swebench harness (Docker)");
