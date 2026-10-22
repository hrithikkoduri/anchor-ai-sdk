#!/usr/bin/env node
/**
 * The comparison table: anchor vs mini — resolved, steps, time, tokens, cost.
 *
 *   node scripts/report.mjs [--write]
 *
 * Sources:
 *   - grading/verdicts.jsonl   (official grader; last verdict per run+task wins)
 *   - <run>/results.jsonl      (steps, wallMs, token usage — anchor is exact)
 *   - <run>/artifacts/*.json   (mini trajectories: api_calls exact; tokens are
 *     an ESTIMATE from serialized history/4, since mini's own cost tracking is
 *     disabled — litellm has no price entry for z-ai/glm-5.3)
 *
 * Costs are recomputed from token counts at the CURRENT provider prices below
 * (the stored costUsd in older rows used stale .env prices — do not trust it).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runsRoot = path.join(root, ".eval-runs");
const gradingDir = path.join(runsRoot, "grading");

// z-ai/glm-5.3 via OpenRouter, USD per million tokens (fetched 2026-10-18).
const PRICE = { in: 0.079, out: 1.4, cacheRead: 0.078 };

const tasks = readFileSync(
  path.join(root, "benchmarks", "swe-bench", "data", "swebench-lite-10.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Last verdict per (run, task).
const verdicts = new Map();
for (const v of readJsonl(path.join(gradingDir, "verdicts.jsonl"))) {
  verdicts.set(`${v.run}::${v.instance}`, v.verdict);
}
const verdictFor = (run, task) => verdicts.get(`${run}::${task}`) ?? "·";

// Results rows (last per task).
function resultsFor(runDir) {
  const map = new Map();
  for (const r of readJsonl(path.join(runsRoot, runDir, "results.jsonl")))
    map.set(r.taskId, r);
  return map;
}

// Mini token estimate from the trajectory: cumulative serialized history / 4.
function miniTokens(runDir, taskId) {
  const file = path.join(runsRoot, runDir, "artifacts", `mini-${taskId}.json`);
  if (!existsSync(file)) return undefined;
  const traj = JSON.parse(readFileSync(file, "utf8"));
  const messages = traj.messages ?? [];
  let prompt = 0;
  let completion = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "assistant") continue;
    prompt += Math.ceil(JSON.stringify(messages.slice(0, i)).length / 4);
    completion += Math.ceil(JSON.stringify(messages[i]).length / 4);
  }
  return { prompt, completion };
}

function anchorCost(usage) {
  if (!usage) return undefined;
  const cached = usage.cachedTokens ?? 0;
  const fresh = Math.max(0, (usage.promptTokens ?? 0) - cached);
  return (
    (fresh / 1e6) * PRICE.in +
    (cached / 1e6) * PRICE.cacheRead +
    ((usage.completionTokens ?? 0) / 1e6) * PRICE.out
  );
}

function miniCost(tokens) {
  if (!tokens) return undefined;
  return (
    (tokens.prompt / 1e6) * PRICE.in + (tokens.completion / 1e6) * PRICE.out
  );
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}
const anchorRun = arg("--anchor", "anchor");
const miniRun = arg("--mini", "mini");

const anchorResults = resultsFor(anchorRun);
const miniResults = resultsFor(miniRun);

const fmt = (n, digits = 0) =>
  n === undefined
    ? "—"
    : n.toLocaleString("en-US", { maximumFractionDigits: digits });
const usd = (n) => (n === undefined ? "—" : `$${n.toFixed(4)}`);
const secs = (ms) => (ms === undefined ? "—" : `${Math.round(ms / 1000)}s`);

let out = "# anchor vs mini — SWE-bench Lite (10 tasks, z-ai/glm-5.3)\n\n";
out +=
  "| task | anchor | steps | time | tokens | $ | mini | steps | time | tokens≈ | $≈ |\n";
out += "|---|---|---|---|---|---|---|---|---|---|---|\n";

const totals = {
  a: { r: 0, steps: 0, ms: 0, tok: 0, usd: 0 },
  m: { r: 0, steps: 0, ms: 0, tok: 0, usd: 0 },
};

for (const task of tasks) {
  const id = task.instance_id;
  const a = anchorResults.get(id);
  const m = miniResults.get(id);
  const aVerdict = verdictFor(anchorRun, id);
  const mVerdict = verdictFor(miniRun, id);
  const aTok = a?.usage
    ? {
        prompt: a.usage.promptTokens ?? 0,
        completion: a.usage.completionTokens ?? 0,
      }
    : undefined;
  const mTok = miniTokens(miniRun, id);
  const aCost = anchorCost(a?.usage);
  const mCost = miniCost(mTok);

  if (aVerdict === "resolved") totals.a.r++;
  if (mVerdict === "resolved") totals.m.r++;
  if (a) {
    totals.a.steps += a.steps ?? 0;
    totals.a.ms += a.wallMs ?? 0;
    totals.a.tok += (aTok?.prompt ?? 0) + (aTok?.completion ?? 0);
    totals.a.usd += aCost ?? 0;
  }
  if (m) {
    totals.m.steps += m.steps ?? 0;
    totals.m.ms += m.wallMs ?? 0;
    totals.m.tok += (mTok?.prompt ?? 0) + (mTok?.completion ?? 0);
    totals.m.usd += mCost ?? 0;
  }

  out +=
    `| ${id} | ${aVerdict} | ${fmt(a?.steps)} | ${secs(a?.wallMs)} | ` +
    `${aTok ? fmt(aTok.prompt + aTok.completion) : "—"} | ${usd(aCost)} | ` +
    `${mVerdict} | ${fmt(m?.steps)} | ${secs(m?.wallMs)} | ` +
    `${mTok ? `≈${fmt(mTok.prompt + mTok.completion)}` : "—"} | ${mCost ? `≈${usd(mCost)}` : "—"} |\n`;
}

out +=
  `| **total** | **${totals.a.r}/10** | ${fmt(totals.a.steps)} | ${secs(totals.a.ms)} | ` +
  `${fmt(totals.a.tok)} | ${usd(totals.a.usd)} | ` +
  `**${totals.m.r}/10** | ${fmt(totals.m.steps)} | ${secs(totals.m.ms)} | ≈${fmt(totals.m.tok)} | ≈${usd(totals.m.usd)} |\n`;
out += `\n_anchor tokens/cost: exact (provider usage, GLM 5.3 rates). mini tokens: estimate (serialized history ÷ 4); cost priced from it — mini's own accounting is disabled because litellm has no GLM 5.3 entry._\n`;

process.stdout.write(out);
if (process.argv.includes("--write")) {
  writeFileSync(path.join(gradingDir, "comparison.md"), out);
  process.stdout.write(
    `\nwritten: ${path.join(gradingDir, "comparison.md")}\n`,
  );
}
