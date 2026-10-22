#!/usr/bin/env node
/**
 * Turn Harbor job results (Terminus-2 / another external agent) into the same
 * bench/model summary shape as the Anchor runs.
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "external-results");
const out = path.resolve(process.argv[3] ?? root);

async function walk(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name === "result.json") files.push(full);
  }
  return files;
}

async function nearestMeta(file) {
  let dir = path.dirname(file);
  while (dir.startsWith(root)) {
    try {
      return JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8"));
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { bench: "external", model: "?", variant: "external", agent: "?" };
}

async function findSweAgentStats(trialDir) {
  const root = path.join(trialDir, "agent", "swe-agent-output");
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".traj")) found.push(full);
    }
  }
  await walk(root);
  for (const file of found) {
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      const stats = data?.info?.model_stats;
      if (stats && (stats.tokens_sent || stats.tokens_received)) {
        return {
          promptTokens: Number(stats.tokens_sent ?? 0),
          completionTokens: Number(stats.tokens_received ?? 0),
          ...(Number(stats.instance_cost) > 0
            ? { costUsd: Number(stats.instance_cost) }
            : {}),
        };
      }
    } catch {
      // try the next trajectory
    }
  }
  return undefined;
}

const groups = new Map();
for (const file of await walk(root)) {
  const meta = await nearestMeta(file);
  let job;
  try {
    job = JSON.parse(await readFile(file, "utf8"));
  } catch {
    continue;
  }
  const key = `${meta.bench}\u0000${meta.model}\u0000${meta.agent}`;
  const group =
    groups.get(key) ??
    {
      bench: meta.bench,
      model: meta.model,
      variant: "external",
      agent: meta.agent,
      results: [],
    };
  const trials = job.trial_results?.length
    ? job.trial_results
    : job.task_name
      ? [job]
      : [];
  for (const trial of trials) {
    const rewards = trial.verifier_result?.rewards ?? {};
    const values = Object.values(rewards).filter((value) => typeof value === "number");
    const reward = values.length > 0 ? Math.max(...values) : 0;
    const started = trial.started_at ? Date.parse(trial.started_at) : NaN;
    const finished = trial.finished_at ? Date.parse(trial.finished_at) : NaN;
    let inputTokens = trial.agent_result?.n_input_tokens ?? 0;
    let outputTokens = trial.agent_result?.n_output_tokens ?? 0;
    let cachedTokens = trial.agent_result?.n_cache_tokens ?? 0;
    let reportedCost = trial.agent_result?.cost_usd;
    // Harbour's SWE-agent adapter does not copy SWE-agent's model_stats into
    // agent_result. The trajectory is authoritative when the adapter reports 0.
    if (!inputTokens && trial.task_name) {
      const stats = await findSweAgentStats(path.dirname(file));
      if (stats) {
        inputTokens = stats.promptTokens;
        outputTokens = stats.completionTokens;
        reportedCost = stats.costUsd;
      }
    }
    group.results.push({
      taskId: trial.task_name,
      status: trial.exception_info ? "failed" : trial.verifier_result ? "completed" : "failed",
      reward,
      ...(trial.exception_info
        ? { error: trial.exception_info.exception_message }
        : {}),
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(cachedTokens > 0 ? { cachedTokens } : {}),
        ...(reportedCost != null ? { costUsd: reportedCost } : {}),
      },
      wallMs: Number.isFinite(started) && Number.isFinite(finished) ? finished - started : 0,
    });
  }
  groups.set(key, group);
}

const rows = [...groups.values()].map((group) => {
  const scored = group.results.filter((r) => typeof r.reward === "number");
  const full = scored.filter((r) => r.reward >= 0.95).length;
  const mean = scored.length
    ? scored.reduce((sum, r) => sum + r.reward, 0) / scored.length
    : undefined;
  const walls = group.results.map((r) => r.wallMs).sort((a, b) => a - b);
  const tokens = group.results.reduce(
    (sum, r) => {
      sum.prompt += r.usage?.promptTokens ?? 0;
      sum.completion += r.usage?.completionTokens ?? 0;
      sum.cached += r.usage?.cachedTokens ?? 0;
      return sum;
    },
    { prompt: 0, completion: 0, cached: 0 },
  );
  return {
    ...group,
    tasks: group.results.length,
    scored: scored.length,
    fullCredit: full,
    meanReward: mean,
    costUsd: group.results.some((r) => r.usage?.costUsd !== undefined)
      ? group.results.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0)
      : undefined,
    tokens,
    cacheHitRate: tokens.prompt > 0 ? tokens.cached / tokens.prompt : undefined,
    p50WallMs: walls.length ? walls[Math.floor(walls.length / 2)] : undefined,
    p95WallMs: walls.length ? walls[Math.min(walls.length - 1, Math.floor(0.95 * walls.length))] : undefined,
  };
});
rows.sort((a, b) => `${a.bench}${a.model}`.localeCompare(`${b.bench}${b.model}`));

const pct = (n, d) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);
const money = (n) => `$${Number(n).toFixed(2)}`;
const mins = (ms) => (ms == null ? "—" : `${Math.round(ms / 60000)}m`);
const tok = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`);

const lines = [
  "# External harness results",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "| Bench | Model | Harness | Tasks | Full credit | Mean reward | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |",
  "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...rows.map(
    (row) =>
      `| ${row.bench} | \`${row.model}\` | ${row.agent} | ${row.tasks} | ${row.fullCredit}/${row.scored} (${pct(row.fullCredit, row.scored)}) | ${row.meanReward == null ? "—" : row.meanReward.toFixed(3)} | ${tok(row.tokens.prompt)} | ${tok(row.tokens.completion)} | ${tok(row.tokens.cached)} | ${row.cacheHitRate == null ? "—" : `${(row.cacheHitRate * 100).toFixed(1)}%`} | ${row.costUsd == null ? "—" : money(row.costUsd)} | ${mins(row.p50WallMs)} | ${mins(row.p95WallMs)} |`,
  ),
  "",
  "## Per task",
  "",
  "| Bench | Model | Task | Reward | Status |",
  "|---|---|---|---:|---|",
  ...rows.flatMap((row) =>
    row.results.map(
      (r) =>
        `| ${row.bench} | \`${row.model}\` | \`${r.taskId}\` | ${r.reward.toFixed(2)} | ${r.status}${r.error ? `: ${r.error.slice(0, 120)}` : ""} |`,
    ),
  ),
  "",
];
const markdown = lines.join("\n");
await mkdir(out, { recursive: true });
await writeFile(
  path.join(out, "summary.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), runs: rows }, null, 2)}\n`,
);
await writeFile(path.join(out, "summary.md"), `${markdown}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
process.stdout.write(`${markdown}\n`);
