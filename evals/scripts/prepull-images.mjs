#!/usr/bin/env node
/**
 * Pre-pull the amd64 eval images for given SWE-bench instances.
 *
 *   node scripts/prepull-images.mjs psf__requests-1963 pytest-dev__pytest-11143
 *   node scripts/prepull-images.mjs --from-predictions <predictions.jsonl>
 *
 * Why this exists: the eval images are amd64-only, and on arm64 the harness's
 * SDK pull cannot pass a platform (it 404s with "no matching manifest for
 * linux/arm64/v8" and the run reports ImageNotFound). Pulling here, with
 * `--platform linux/amd64`, makes the harness's local `images.get` succeed;
 * the container then runs under Docker Desktop's emulation.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const DATASET = "SWE-bench/SWE-bench_Lite";
const argv = process.argv.slice(2);

let ids = argv.filter((arg) => !arg.startsWith("--"));
const fromIndex = argv.indexOf("--from-predictions");
if (fromIndex !== -1) {
  const file = argv[fromIndex + 1];
  if (!file) {
    console.error("--from-predictions needs a path");
    process.exit(1);
  }
  const lines = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean);
  ids = lines.map((line) => JSON.parse(line).instance_id);
}
const fromTasksIndex = argv.indexOf("--from-tasks");
if (fromTasksIndex !== -1) {
  const file = argv[fromTasksIndex + 1];
  if (!file) {
    console.error("--from-tasks needs a path");
    process.exit(1);
  }
  const lines = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean);
  ids = lines.map((line) => JSON.parse(line).instance_id);
}
if (ids.length === 0) {
  console.error(
    "usage: prepull-images.mjs <instance_id...> | --from-tasks <file> | --from-predictions <file>",
  );
  process.exit(1);
}

const docker = process.env.DOCKER_BIN ?? "docker";

async function fetchRows(offset, length) {
  const url =
    `https://datasets-server.huggingface.co/rows` +
    `?dataset=${encodeURIComponent(DATASET)}&config=default&split=test` +
    `&offset=${offset}&length=${length}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`dataset fetch failed: ${res.status}`);
  return (await res.json()).rows.map((item) => item.row);
}

const wanted = new Set(ids);
const images = new Map();
for (let offset = 0; offset < 300 && images.size < wanted.size; offset += 100) {
  for (const row of await fetchRows(offset, 100)) {
    if (wanted.has(row.instance_id)) images.set(row.instance_id, row.image);
  }
}

let pulled = 0;
let present = 0;
for (const id of ids) {
  const image = images.get(id);
  if (!image) {
    console.error(`  ${id}: not in ${DATASET} — skipping`);
    continue;
  }
  if (spawnSync(docker, ["image", "inspect", image], { stdio: "ignore" }).status === 0) {
    present += 1;
    console.log(`  ${id}: present`);
    continue;
  }
  console.log(`  ${id}: pulling ${image} (linux/amd64)…`);
  const pull = spawnSync(docker, ["pull", "--platform", "linux/amd64", image], {
    stdio: "inherit",
  });
  if (pull.status !== 0) {
    console.error(`  ${id}: pull FAILED`);
    process.exitCode = 1;
    continue;
  }
  pulled += 1;
  console.log(`  ${id}: pulled`);
}
console.log(`images: ${pulled} pulled, ${present} already present`);
