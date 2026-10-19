#!/usr/bin/env node
/**
 * Fetch a SWE-bench subset as a compact task JSONL.
 *
 *   node scripts/fetch-tasks.mjs --limit 10 --out data/swebench-lite-10.jsonl
 *
 * Only what the runner needs is kept: instance_id, repo, base_commit,
 * problem_statement (+ FAIL_TO_PASS / PASS_TO_PASS for the report). Golden
 * patches stay out — the official grader loads the full dataset itself and
 * matches predictions by instance_id.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const argv = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (!token.startsWith("--")) continue;
  const [key, inline] = token.slice(2).split("=", 2);
  if (inline !== undefined) {
    args.set(key, inline);
  } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
    args.set(key, argv[i + 1]);
    i++;
  } else {
    args.set(key, "true");
  }
}

const dataset = args.get("dataset") ?? "SWE-bench/SWE-bench_Lite";
const split = args.get("split") ?? "test";
const offset = Number(args.get("offset") ?? 0);
const limit = Number(args.get("limit") ?? 10);
const out = args.get("out") ?? "data/tasks.jsonl";

const KEEP = [
  "instance_id",
  "repo",
  "base_commit",
  "problem_statement",
  "FAIL_TO_PASS",
  "PASS_TO_PASS",
  "image",
];

async function fetchRows(from, count) {
  const length = Math.min(100, count);
  const url =
    `https://datasets-server.huggingface.co/rows` +
    `?dataset=${encodeURIComponent(dataset)}&config=default&split=${split}` +
    `&offset=${from}&length=${length}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`dataset fetch failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return (body.rows ?? []).map((item) => item.row);
}

const rows = [];
for (let fetched = 0; fetched < limit; fetched += 100) {
  rows.push(...(await fetchRows(offset + fetched, limit - fetched)));
}

const lines = rows.map((row) =>
  JSON.stringify(
    Object.fromEntries(
      KEEP.filter((key) => row[key] !== undefined).map((key) => [
        key,
        row[key],
      ]),
    ),
  ),
);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} task(s) from ${dataset} to ${out}`);
