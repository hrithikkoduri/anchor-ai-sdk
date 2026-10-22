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
  for (const trial of job.trial_results ?? []) {
    const rewards = trial.verifier_result?.rewards ?? {};
    const values = Object.values(rewards).filter((value) => typeof value === "number");
    const reward = values.length > 0 ? Math.max(...values) : 0;
    const started = trial.started_at ? Date.parse(trial.started_at) : NaN;
    const finished = trial.finished_at ? Date.parse(trial.finished_at) : NaN;
    group.results.push({
      taskId: trial.task_name,
      status: trial.exception_info ? "failed" : trial.verifier_result ? "completed" : "failed",
      reward,
      ...(trial.exception_info
        ? { error: trial.exception_info.exception_message }
        : {}),
      ...(trial.agent_result?.cost_usd != null
        ? { usage: { costUsd: trial.agent_result.cost_usd } }
        : {}),
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
  return {
    ...group,
    tasks: group.results.length,
    scored: scored.length,
    fullCredit: full,
    meanReward: mean,
    costUsd: group.results.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0),
    p50WallMs: walls.length ? walls[Math.floor(walls.length / 2)] : undefined,
  };
});
rows.sort((a, b) => `${a.bench}${a.model}`.localeCompare(`${b.bench}${b.model}`));

const pct = (n, d) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);
const money = (n) => `$${Number(n).toFixed(2)}`;
const mins = (ms) => (ms == null ? "—" : `${Math.round(ms / 60000)}m`);

const lines = [
  "# External harness results",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "| Bench | Model | Harness | Tasks | Full credit | Mean reward | Cost | p50 |",
  "|---|---|---|---:|---:|---:|---:|---:|",
  ...rows.map(
    (row) =>
      `| ${row.bench} | \`${row.model}\` | ${row.agent} | ${row.tasks} | ${row.fullCredit}/${row.scored} (${pct(row.fullCredit, row.scored)}) | ${row.meanReward == null ? "—" : row.meanReward.toFixed(3)} | ${money(row.costUsd)} | ${mins(row.p50WallMs)} |`,
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
