/**
 * Verify one prediction against SWE-bench's official test list, inside E2B.
 *
 * This is a fast, E2B-native check — not a replacement for the official
 * `swebench` grader. It applies the dataset's test patch and the model's patch,
 * runs the FAIL_TO_PASS + PASS_TO_PASS ids in the task's own image (booted as
 * an E2B template), and reports pass/fail. The official grader remains the
 * source of truth for a published number.
 *
 *   E2B_API_KEY=... node evals/scripts/verify-e2b-prediction.mjs \
 *     --prediction .eval-runs/<run>/predictions.jsonl \
 *     --instance pytest-dev__pytest-11143 \
 *     --template anchor-swebench-pytest-dev-pytest-11143:latest
 */
import { readFileSync } from "node:fs";
import { Sandbox } from "e2b";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const predictionFile = arg("prediction");
const instanceId = arg("instance");
const template = arg("template");
const dataset = arg("dataset", "SWE-bench/SWE-bench_Lite");
const split = arg("split", "test");

if (!predictionFile || !instanceId || !template) {
  console.error(
    "usage: node evals/scripts/verify-e2b-prediction.mjs --prediction <predictions.jsonl> --instance <id> --template <name:tag>",
  );
  process.exit(1);
}

const prediction = readFileSync(predictionFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .find((row) => row.instance_id === instanceId);
if (!prediction) {
  console.error(`no prediction for ${instanceId} in ${predictionFile}`);
  process.exit(1);
}

async function datasetRow() {
  const base = "https://datasets-server.huggingface.co/rows";
  for (let offset = 0; ; offset += 100) {
    const url =
      `${base}?dataset=${encodeURIComponent(dataset)}&config=default` +
      `&split=${encodeURIComponent(split)}&offset=${offset}&length=100`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`dataset fetch failed: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    const rows = body.rows ?? [];
    const found = rows.find((item) => item.row?.instance_id === instanceId);
    if (found) return found.row;
    if (rows.length < 100) break;
  }
  throw new Error(`${instanceId} not found in ${dataset}`);
}

const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const row = await datasetRow();
const allIds = [...(row.FAIL_TO_PASS ?? []), ...(row.PASS_TO_PASS ?? [])];
// A handful of parameterized ids in the Lite dataset are truncated at a
// space ("...[assert"), which pytest cannot resolve. Skip those loudly; the
// official grader is the source of truth and the file-level tests still run
// in the manual check.
const balanced = (id) =>
  (id.match(/\[/g) ?? []).length === (id.match(/\]/g) ?? []).length;
const ids = allIds.filter(balanced);
const dropped = allIds.length - ids.length;
if (!row.test_patch || ids.length === 0) {
  console.error(`${instanceId} has no test patch / test ids`);
  process.exit(1);
}
if (dropped) {
  console.log(`skipping ${dropped} malformed dataset id(s) with unbalanced brackets`);
}

console.log(`${instanceId}: ${ids.length} official test ids`);
console.log(`template: ${template}`);
console.log(`patch: ${prediction.model_patch.length} chars`);

let sandbox;
try {
  sandbox = await Sandbox.create(template, { timeoutMs: 900_000 });
  await sandbox.files.write("/tmp/swe-test.patch", row.test_patch);
  await sandbox.files.write("/tmp/swe-model.patch", prediction.model_patch);

  const command =
    "source /root/.bashrc && cd /testbed && " +
    "git apply /tmp/swe-test.patch && git apply /tmp/swe-model.patch && " +
    `python -m pytest -q -W ignore::DeprecationWarning ${ids.map(shq).join(" ")}`;

  try {
    const result = await sandbox.commands.run(command, {
      user: "root",
      timeoutMs: 600_000,
    });
    console.log("\nPASS");
    console.log(result.stdout.trim().slice(-3000));
  } catch (error) {
    console.log("\nFAIL");
    console.log(
      (error.stderr || error.stdout || error.message || String(error))
        .trim()
        .slice(-5000),
    );
    process.exitCode = 1;
  }
} finally {
  if (sandbox) await sandbox.kill().catch(() => undefined);
}
