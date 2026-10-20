/**
 * Build E2B templates from SWE-bench task images, so the eval harness can run
 * a task on E2B instead of Docker.
 *
 *   E2B_API_KEY=... node evals/scripts/build-e2b-templates.mjs \
 *     --tasks evals/data/swebench-lite-10.jsonl --limit 1
 *
 *   # one task, explicit name:
 *   ... --tasks evals/data/swebench-lite-10.jsonl --task psf__requests-1963
 *
 * At the end it prints the JSON to put in E2B_TEMPLATE_MAP, keyed by instance
 * id (the eval also accepts the Docker image as a key).
 *
 * E2B boots templates, not Docker images. `Template().fromImage()` preserves
 * the image filesystem (including /testbed and the conda env) and adds E2B's
 * agent. SWE-bench images are amd64 and 1–2 GB; builds take a few minutes each.
 */
import { readFileSync } from "node:fs";
import { Template, defaultBuildLogger } from "e2b";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const tasksFile = arg("tasks");
if (!tasksFile) {
  console.error(
    "usage: node evals/scripts/build-e2b-templates.mjs --tasks <file.jsonl> [--task <id>] [--limit <n>] [--tag latest]",
  );
  process.exit(1);
}

const only = arg("task");
const limit = Number(arg("limit", "0")) || 0;
const tag = arg("tag", "latest");
const cpuCount = Number(arg("cpu", "4"));
const memoryMB = Number(arg("memory", "8192"));

const rows = readFileSync(tasksFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((row) => row.instance_id && row.image)
  .filter((row) => (only ? row.instance_id === only : true))
  .slice(0, limit || undefined);

if (rows.length === 0) {
  console.error(`no image-backed tasks matched in ${tasksFile}`);
  process.exit(1);
}

const mapping = {};
for (const row of rows) {
  const slug = String(row.instance_id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = `anchor-swebench-${slug}:${tag}`;
  console.log(`\n=== ${row.instance_id} ===\n${row.image} → ${name}`);
  const template = Template().fromImage(String(row.image));
  await Template.build(template, name, {
    cpuCount,
    memoryMB,
    onBuildLogs: defaultBuildLogger(),
  });
  mapping[String(row.instance_id)] = name;
  mapping[String(row.image)] = name;
}

console.log("\nE2B_TEMPLATE_MAP=" + JSON.stringify(mapping));
