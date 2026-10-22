#!/usr/bin/env node
/**
 * Turn the committed SWE-bench Lite rows into the same Harbor task-directory
 * shape used by Pro and Terminal. This lets an external Harbor agent run the
 * identical 10 Lite tasks; the test patch + fail-to-pass list are the verifier.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const dataDir = path.join(root, "evals/benchmarks/swe-bench-lite/data");
const source = path.join(
  root,
  "evals/benchmarks/swe-bench/data/swebench-lite-10-local.jsonl",
);
const rows = (await readFile(source, "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const manifest = [];
for (const row of rows) {
  const id = row.instance_id;
  const dir = path.join(dataDir, "tasks", id);
  await mkdir(path.join(dir, "tests"), { recursive: true });
  await writeFile(
    path.join(dir, "task.toml"),
    [
      'schema_version = "1.4"',
      "",
      "[task]",
      `name = "swe-bench-lite/${id}"`,
      `description = ${JSON.stringify(row.problem_statement.split("\n")[0])}`,
      "",
      "[environment]",
      `docker_image = ${JSON.stringify(row.image)}`,
      'os = "linux"',
      "cpus = 2",
      "memory_mb = 4096",
      "storage_mb = 10240",
      "",
      "[agent]",
      "timeout_sec = 900.0",
      'network_mode = "public"',
      "",
      "[verifier]",
      "timeout_sec = 900.0",
      'network_mode = "public"',
      "",
    ].join("\n"),
  );
  await writeFile(path.join(dir, "instruction.md"), row.problem_statement);
  await writeFile(path.join(dir, "tests", "test_patch.patch"), row.test_patch);
  const tests = Array.isArray(row.FAIL_TO_PASS)
    ? row.FAIL_TO_PASS
    : JSON.parse(row.FAIL_TO_PASS ?? "[]");
  const quoted = tests.map((test) => `'${String(test).replaceAll("'", "'\\''")}'`).join(" ");
  await writeFile(
    path.join(dir, "tests", "test.sh"),
    [
      "#!/bin/bash",
      "set -uo pipefail",
      "cd /testbed || exit 1",
      "git apply /tests/test_patch.patch || exit 1",
      `python -m pytest -q ${quoted}`,
      "code=$?",
      "mkdir -p /logs/verifier",
      "if [ \"$code\" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi",
      "exit \"$code\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    path.join(dir, "tests", "config.json"),
    JSON.stringify(
      {
        fail_to_pass: row.FAIL_TO_PASS,
        pass_to_pass: row.PASS_TO_PASS,
      },
      null,
      2,
    ) + "\n",
  );
  manifest.push({
    id,
    kind: "harbor",
    path: `tasks/${id}`,
    grading: "in-place",
    workspacePath: "/testbed",
  });
}
await writeFile(
  path.join(dataDir, "tasks.jsonl"),
  manifest.map((row) => JSON.stringify(row)).join("\n") + "\n",
);
console.log(`wrote ${manifest.length} Lite Harbor tasks`);
