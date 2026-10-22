#!/usr/bin/env node
/**
 * Fetch the two Harbor-format benchmark subsets we run in CI.
 *
 * Both benchmarks ship a task directory with task.toml + instruction.md +
 * tests/. We keep those files in-repo so an Actions run is one checkout and a
 * Docker pull; no HuggingFace token or benchmark download at run time.
 *
 *   node evals/scripts/fetch-harbor-tasks.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);

async function get(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "anchor-evals-fetch" },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

async function download(url, file) {
  const res = await get(url);
  const body = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}

async function hfTree(dataset, dir) {
  const url = `https://huggingface.co/api/datasets/${dataset}/tree/main/${dir}`;
  const res = await get(url);
  return await res.json();
}

async function hfDownload(dataset, dir, file, base) {
  const url = `https://huggingface.co/datasets/${dataset}/resolve/main/${dir}/${file}`;
  await download(url, path.join(base, file));
}

async function fetchTerminalBench(ids) {
  const dataset = "harborframework/terminal-bench-2.1";
  const base = path.join(root, "evals/benchmarks/terminal-bench/data");
  const rows = [];
  for (const id of ids) {
    const dir = `tasks/${id}`;
    const taskBase = path.join(base, dir);
    await hfDownload(dataset, dir, "task.toml", taskBase);
    await hfDownload(dataset, dir, "instruction.md", taskBase);
    for (const entry of await hfTree(dataset, `${dir}/tests`)) {
      if (entry.type !== "file") continue;
      await hfDownload(dataset, `${dir}/tests`, entry.path.split("/").pop(), path.join(taskBase, "tests"));
    }
    rows.push({
      id,
      kind: "harbor",
      path: dir,
      grading: "in-place",
      workspacePath: "/app",
    });
    process.stdout.write(`terminal-bench: ${id}\n`);
  }
  await mkdir(path.join(base, ".."), { recursive: true });
  await writeFile(
    path.join(base, "tasks.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}

async function githubContents(repo, dir) {
  const url = `https://api.github.com/repos/${repo}/contents/${dir}?ref=main`;
  const res = await get(url);
  return await res.json();
}

async function fetchSwePro(ids) {
  const repo = "scaleapi/SWE-bench_Pro-os";
  const base = path.join(root, "evals/benchmarks/swe-bench-pro/data");
  const rows = [];
  for (const id of ids) {
    const dir = `v2/tasks/${id}`;
    const taskBase = path.join(base, "tasks", id);
    for (const file of ["task.toml", "instruction.md"]) {
      await download(
        `https://raw.githubusercontent.com/${repo}/main/${dir}/${file}`,
        path.join(taskBase, file),
      );
    }
    for (const entry of await githubContents(repo, `${dir}/tests`)) {
      if (entry.type !== "file") continue;
      await download(entry.download_url, path.join(taskBase, "tests", entry.name));
    }
    rows.push({
      id,
      kind: "harbor",
      path: `tasks/${id}`,
      grading: "patch",
      workspacePath: "/app",
    });
    process.stdout.write(`swe-bench-pro: ${id}\n`);
  }
  await writeFile(
    path.join(base, "tasks.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}

const terminal = [
  "adaptive-rejection-sampler",
  "bn-fit-modify",
  "break-filter-js-from-html",
  "build-cython-ext",
  "cancel-async-tasks",
  "chess-best-move",
  "circuit-fibsqrt",
  "cobol-modernization",
  "code-from-image",
  "compile-compcert",
];

await fetchTerminalBench(terminal);

// 10 SWE-bench Pro V2 tasks, one per language where possible. The HF rows
// endpoint is public; select deterministically so re-fetching is stable.
const languages = ["go", "python", "js", "ts"];
const chosen = [];
const perLanguage = new Map();
const seenRepos = new Set();
for (let offset = 0; chosen.length < 10 && offset < 700; offset += 100) {
  const res = await get(
    `https://datasets-server.huggingface.co/rows?dataset=ScaleAI%2FSWE-bench_Pro&config=default&split=test&offset=${offset}&length=100`,
  );
  const body = await res.json();
  for (const { row } of body.rows) {
    const language = row.repo_language;
    if (!languages.includes(language)) continue;
    // Prefer distinct repositories, but do not let the dataset's repo-sorted
    // order stop us at five tasks.
    if (seenRepos.has(row.repo) && chosen.length < 8) continue;
    const count = perLanguage.get(language) ?? 0;
    if (count >= 3) continue;
    seenRepos.add(row.repo);
    perLanguage.set(language, count + 1);
    chosen.push(row.instance_id);
    if (chosen.length === 10) break;
  }
}
if (chosen.length < 10) throw new Error(`only found ${chosen.length} SWE Pro tasks`);
await fetchSwePro(chosen);
