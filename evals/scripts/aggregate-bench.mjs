#!/usr/bin/env node
/**
 * Merge every benchmark artifact into one summary. Input is a directory of
 * eval output directories (each with run.json + results.jsonl); output is
 * summary.json + summary.md for the bench-results branch and the Actions job
 * summary.
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".bench-results");
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
    else if (entry.name === "run.json") files.push(full);
  }
  return files;
}

const runs = [];
for (const runFile of await walk(root)) {
  const dir = path.dirname(runFile);
  const run = JSON.parse(await readFile(runFile, "utf8"));
  let results = [];
  try {
    results = (await readFile(path.join(dir, "results.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    // A run that died before writing results is still a data point.
  }
  runs.push({ run, results, dir });
}

const groups = new Map();
for (const { run, results, dir } of runs) {
  const key = `${run.bench ?? "unknown"}\u0000${run.model ?? "?"}\u0000${run.variant ?? "baseline"}`;
  const group =
    groups.get(key) ??
    {
      bench: run.bench ?? "unknown",
      model: run.model ?? "?",
      variant: run.variant ?? "baseline",
      results: [],
      runs: [],
      costUsd: 0,
    };
  group.results.push(...results);
  group.runs.push({ ...run, dir });
  group.costUsd += Number(run.totalUsd ?? 0);
  groups.set(key, group);
}

const rows = [...groups.values()].map((group) => {
  const scored = group.results.filter((r) => typeof r.reward === "number");
  const full = scored.filter((r) => r.reward >= 0.95).length;
  const mean =
    scored.length === 0
      ? undefined
      : scored.reduce((sum, r) => sum + r.reward, 0) / scored.length;
  const walls = group.results.map((r) => r.wallMs ?? 0).sort((a, b) => a - b);
  const tokens = group.results.reduce(
    (sum, r) => {
      sum.prompt += r.usage?.promptTokens ?? 0;
      sum.completion += r.usage?.completionTokens ?? 0;
      sum.total += r.usage?.totalTokens ?? 0;
      sum.cached += r.usage?.cachedTokens ?? 0;
      sum.reasoning += r.usage?.reasoningTokens ?? 0;
      return sum;
    },
    { prompt: 0, completion: 0, total: 0, cached: 0, reasoning: 0 },
  );
  return {
    bench: group.bench,
    model: group.model,
    variant: group.variant,
    tasks: group.results.length,
    scored: scored.length,
    fullCredit: full,
    meanReward: mean,
    falseFinishes: group.results.filter((r) => r.falseFinish).length,
    timeouts: group.results.filter((r) => r.timedOut).length,
    costUsd: group.costUsd,
    tokens,
    cacheHitRate: tokens.prompt > 0 ? tokens.cached / tokens.prompt : undefined,
    p50WallMs: walls.length ? walls[Math.floor(walls.length / 2)] : undefined,
    p95WallMs: walls.length ? walls[Math.min(walls.length - 1, Math.floor(0.95 * walls.length))] : undefined,
    runs: group.runs,
    results: group.results,
  };
});
rows.sort((a, b) =>
  `${a.bench}${a.model}${a.variant}`.localeCompare(
    `${b.bench}${b.model}${b.variant}`,
  ),
);

const pct = (n, d) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);
const money = (n) => `$${Number(n).toFixed(2)}`;
const mins = (ms) =>
  ms === undefined ? "—" : `${Math.round(ms / 60000)}m`;
const tok = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`);

const lines = [
  "# Anchor benchmark results",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "| Bench | Model | Variant | Tasks | Full credit | Mean reward | False finish | Timeout | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |",
  "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...rows.map(
    (row) =>
      `| ${row.bench} | \`${row.model}\` | ${row.variant} | ${row.tasks} | ${row.fullCredit}/${row.scored} (${pct(row.fullCredit, row.scored)}) | ${row.meanReward === undefined ? "—" : row.meanReward.toFixed(3)} | ${row.falseFinishes} | ${row.timeouts} | ${tok(row.tokens.prompt)} | ${tok(row.tokens.completion)} | ${tok(row.tokens.cached)} | ${row.cacheHitRate === undefined ? "—" : `${(row.cacheHitRate * 100).toFixed(1)}%`} | ${money(row.costUsd)} | ${mins(row.p50WallMs)} | ${mins(row.p95WallMs)} |`,
  ),
  "",
  "## Per task",
  "",
  "| Bench | Model | Variant | Task | Reward | Status | Steps | Prompt tok | Completion tok | Cached tok | Cost | Wall |",
  "|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|",
  ...rows.flatMap((row) =>
    row.results.map(
      (r) =>
        `| ${row.bench} | \`${row.model}\` | ${row.variant} | \`${r.taskId}\` | ${r.reward === undefined ? "—" : r.reward.toFixed(2)} | ${r.status}${r.falseFinish ? " (false finish)" : ""}${r.timedOut ? " (timeout)" : ""} | ${r.steps ?? "—"} | ${tok(r.usage?.promptTokens ?? 0)} | ${tok(r.usage?.completionTokens ?? 0)} | ${tok(r.usage?.cachedTokens ?? 0)} | ${money(r.usage?.costUsd ?? 0)} | ${mins(r.wallMs)} |`,
    ),
  ),
  "",
];
const markdown = lines.join("\n");
const summary = {
  generatedAt: new Date().toISOString(),
  runs: rows.map(({ results: _results, ...row }) => row),
  results: rows.flatMap((row) =>
    row.results.map((result) => ({
      bench: row.bench,
      model: row.model,
      variant: row.variant,
      ...result,
    })),
  ),
};

await mkdir(out, { recursive: true });
await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(path.join(out, "summary.md"), `${markdown}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
process.stdout.write(`${markdown}\n`);
