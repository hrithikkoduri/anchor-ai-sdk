import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tasks, totals, round } from "../src/benchmark-data.js";

const sdk =
  process.env.ANCHOR_SDK_SOURCE ??
  fileURLToPath(new URL("../../", import.meta.url));
const root = join(sdk, "evals/benchmarks/swe-bench/results");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const jsonl = async (file) =>
  (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
for (const arm of ["anchor", "mini"]) {
  const folder = join(
    root,
    arm === "anchor" ? round.anchorPath : round.miniPath,
  );
  const results = await jsonl(join(folder, "results.jsonl"));
  const verdicts = await jsonl(join(folder, "verdicts.jsonl"));
  const manifest = await json(join(folder, "manifest.json"));
  const grading = await json(
    join(
      folder,
      "grading",
      arm === "anchor" ? "glm-5.3-parasail.json" : "mini.json",
    ),
  );
  const run = await json(
    join(
      folder,
      arm === "anchor" ? "runs/glm-5.3-parasail/run.json" : "run.json",
    ),
  );
  for (const entries of [results, verdicts, manifest])
    assert.equal(entries.length, 10);
  assert.equal(grading.resolved_instances, 9);
  assert.equal(grading.submitted_instances, 10);
  assert.equal(run.model, round.model);
  assert.equal(run.llm, "parasail");
  assert.equal(run.sampling.temperature, 0);
  assert.equal(run.sampling.seed, 42);
  assert.equal(run.provider, "docker");
  for (const task of tasks) {
    const result = results.find((entry) => entry.taskId === task.id);
    const verdict = verdicts.find((entry) => entry.instance_id === task.id);
    const receipt = manifest.find((entry) => entry.task === task.id);
    assert.ok(result && verdict && receipt, task.id);
    const expected = [
      verdict.verdict === "resolved",
      result.steps ?? null,
      result.wallMs / 1000,
      result.usage?.totalTokens ?? null,
      result.usage?.costUsd ?? null,
    ];
    assert.deepEqual(task[arm], expected, `${arm} ${task.id}`);
    assert.equal(receipt.verdict, verdict.verdict);
    assert.equal(grading.resolved_ids.includes(task.id), task[arm][0]);
    const patch = await readFile(join(folder, "patches", task.id + ".diff"));
    assert.equal(
      createHash("sha1").update(patch).digest("hex").slice(0, 12),
      receipt.patch_sha1_12,
    );
  }
  assert.equal(
    results.reduce((sum, entry) => sum + entry.wallMs, 0) / 1000,
    totals[arm].seconds,
  );
  if (arm === "anchor") {
    assert.equal(
      results.reduce((sum, entry) => sum + entry.usage.totalTokens, 0),
      totals.anchor.tokens,
    );
    assert.ok(
      Math.abs(
        results.reduce((sum, entry) => sum + entry.usage.costUsd, 0) -
          totals.anchor.usd,
      ) < 1e-8,
    );
    assert.equal(
      results.reduce((sum, entry) => sum + entry.steps, 0),
      totals.anchor.steps,
    );
  } else {
    assert.equal(grading.empty_patch_instances, 1);
    assert.deepEqual(grading.empty_patch_ids, ["matplotlib__matplotlib-18869"]);
    assert.equal(
      results.reduce((sum, entry) => sum + (entry.steps ?? 0), 0),
      totals.mini.reportedSteps,
    );
    assert.ok(results.every((entry) => !entry.usage));
    assert.equal(totals.mini.usd, null);
    assert.equal(totals.mini.tokens, null);
  }
}
console.log(
  "PASS: 20 task records, verdicts, grading membership, patch digests, settings and displayed totals match the completed artifacts.",
);
