#!/usr/bin/env node
/**
 * Watch eval runs and grade every task the moment it finishes.
 *
 *   node scripts/watch-and-grade.mjs \
 *     --watch .eval-runs/mini-10-glm --watch .eval-runs/anchor-10-glm-tuned
 *
 * Polls each run's results.jsonl; for each completed task not yet graded it
 * takes the LAST prediction for that instance, runs the official SWE-bench
 * grader on it (serially — never two graders at once), and appends the verdict
 * to .eval-runs/grading/verdicts.jsonl. State survives restarts in
 * .eval-runs/grading/watch-state.json (per run dir: graded ids + attempts).
 * Empty patches are graded too (the harness reports them as empty; correct).
 *
 * Preconditions: images already pulled (scripts/prepull-images.mjs) and the
 * grader venv at evals/.venv. Docker Desktop's CLI is found via the
 * standard macOS path below (override with DOCKER_BIN).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const watchDirs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--watch" && argv[i + 1]) watchDirs.push(argv[++i]);
}
const intervalSecs = 45;
if (watchDirs.length === 0) {
  console.error("usage: watch-and-grade.mjs --watch <runDir> [--watch <runDir> ...]");
  process.exit(1);
}

const dockerBin = process.env.DOCKER_BIN ?? "/Applications/Docker.app/Contents/Resources/bin/docker";
const python = path.join(root, ".venv", "bin", "python");
const gradingRoot = path.join(root, ".eval-runs", "grading");
const reportsDir = path.join(gradingRoot, "watch-reports");
const dockerConfigDir = path.join(gradingRoot, "watch-docker-config");
mkdirSync(reportsDir, { recursive: true });
mkdirSync(dockerConfigDir, { recursive: true });
writeFileSync(path.join(dockerConfigDir, "config.json"), "{}");

const statePath = path.join(gradingRoot, "watch-state.json");
const ledgerPath = path.join(gradingRoot, "verdicts.jsonl");
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {};
const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

function lastPredictions(runDir) {
  const file = path.join(root, runDir, "predictions.jsonl");
  if (!existsSync(file)) return new Map();
  const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const map = new Map();
  for (const line of rows) {
    try {
      const row = JSON.parse(line);
      map.set(row.instance_id, row);
    } catch {}
  }
  return map;
}

function completedIds(runDir) {
  const file = path.join(root, runDir, "results.jsonl");
  if (!existsSync(file)) return [];
  const ids = [];
  for (const line of readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
    try {
      ids.push(JSON.parse(line).taskId);
    } catch {}
  }
  return [...new Set(ids)];
}

function gradeOne(runKey, instance, prediction) {
  const predFile = path.join(gradingRoot, `watch-pred-${runKey}-${instance}.jsonl`);
  writeFileSync(predFile, `${JSON.stringify(prediction)}\n`);
  // Unique per attempt: two graders (or a re-grade) must never share container
  // names — a collision silently corrupts verdicts (observed 2026-10-18).
  const runId = `watch-${runKey}-${instance}-${Date.now()}`;
  log(`grading ${runKey} :: ${instance}`);
  const result = spawnSync(
    python,
    ["-m", "swebench.harness.run_evaluation",
     "-d", "SWE-bench/SWE-bench_Lite",
     "-i", instance,
     "-p", predFile,
     "-id", runId,
     "--max_workers", "1",
     "--report_dir", path.join(reportsDir, runKey)],
    {
      cwd: gradingRoot,
      encoding: "utf8",
      timeout: 30 * 60 * 1000,
      env: {
        ...process.env,
        DOCKER_CONFIG: dockerConfigDir,
        PATH: `${path.dirname(dockerBin)}:${process.env.PATH ?? ""}`,
      },
    },
  );
  const reportDir = path.join(reportsDir, runKey);
  let verdict = "grader-failed";
  try {
    const reportFile = spawnSync("ls", ["-t", reportDir], { encoding: "utf8" })
      .stdout.split("\n")
      .find((f) => f.endsWith(`${runId}.json`));
    if (reportFile) {
      const report = JSON.parse(readFileSync(path.join(reportDir, reportFile), "utf8"));
      verdict = (report.resolved_ids ?? []).includes(instance)
        ? "resolved"
        : (report.empty_patch_ids ?? []).includes(instance)
          ? "empty"
          : "unresolved";
    }
  } catch {}
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({ at: new Date().toISOString(), run: runKey, instance, verdict })}\n`,
  );
  log(`${runKey} :: ${instance} → ${verdict}${result.status !== 0 ? " (grader exited nonzero)" : ""}`);
}

log(`watching: ${watchDirs.join(", ")}`);
let stopped = false;
process.on("SIGTERM", () => (stopped = true));
process.on("SIGINT", () => (stopped = true));

while (!stopped) {
  for (const runDir of watchDirs) {
    const key = path.basename(runDir);
    state[key] ??= [];
    const predictions = lastPredictions(runDir);
    for (const instance of completedIds(runDir)) {
      if (state[key].includes(instance)) continue;
      const prediction = predictions.get(instance);
      if (!prediction) continue; // results landed before predictions — next tick
      state[key].push(instance);
      saveState();
      gradeOne(key, instance, prediction);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, intervalSecs * 1000));
}
log("stopped");
