#!/usr/bin/env node
/**
 * Prewarm mini-swe-agent into a committed image per task image, in parallel.
 *
 *   node scripts/prewarm-mini-images.mjs --from-tasks benchmarks/swe-bench/data/swebench-lite-10.jsonl
 *
 * The install runs UNDER x86 EMULATION inside the task container and takes
 * minutes; doing it once per task image means eval runs never pay it again.
 * Each result lands as `<repo>:<tag>` (default tag `mini-eval`) — run the eval
 * with `--image-tag mini-eval` to boot them. The install line mirrors
 * src/arms/mini-swe.ts (MINI_INSTALL_COMMAND) — keep them in sync.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (!token.startsWith("--")) continue;
  const [key, inline] = token.slice(2).split("=", 2);
  if (inline !== undefined) args.set(key, inline);
  else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
    args.set(key, argv[i + 1]);
    i++;
  } else args.set(key, "true");
}

const tasksFile = args.get("from-tasks");
if (!tasksFile) {
  console.error(
    "usage: prewarm-mini-images.mjs --from-tasks <file.jsonl> [--tag mini-eval] [--concurrency 3]",
  );
  process.exit(1);
}
const tag = args.get("tag") ?? "mini-eval";
const concurrency = Number(args.get("concurrency") ?? 3);
const docker = process.env.DOCKER_BIN ?? "docker";

const INSTALL =
  "/opt/mini-venv/bin/python -c 'import minisweagent' 2>/dev/null || " +
  "{ python -m venv /opt/mini-venv && /opt/mini-venv/bin/pip install --quiet mini-swe-agent 'litellm==1.106.0' mcp; }";

const tasks = (await readFile(tasksFile, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((task) => task.image);

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    child.on("error", (err) =>
      resolve({ code: -1, out: `${out}${err.message}` }),
    );
    child.on("close", (code) => resolve({ code, out }));
  });
}

const withTag = (image) => `${image.replace(/:[^:/]+$/, "")}:${tag}`;

async function prewarm(task, index) {
  const target = withTag(task.image);
  const have = await run(docker, ["image", "inspect", target]);
  if (have.code === 0) {
    console.log(`[${index}] ${task.instance_id}: present (${target})`);
    return true;
  }
  const name = `prewarm-mini-${index}`;
  await run(docker, ["rm", "-f", name]);
  const start = await run(docker, [
    "run",
    "-d",
    "--name",
    name,
    "--entrypoint",
    "sleep",
    task.image,
    "infinity",
  ]);
  if (start.code !== 0) {
    console.error(
      `[${index}] ${task.instance_id}: run failed: ${start.out.trim().slice(-300)}`,
    );
    return false;
  }
  console.log(
    `[${index}] ${task.instance_id}: installing (emulated — minutes)…`,
  );
  const install = await run(docker, ["exec", name, "bash", "-c", INSTALL]);
  if (install.code !== 0) {
    console.error(
      `[${index}] ${task.instance_id}: install FAILED: ${install.out.trim().slice(-400)}`,
    );
    await run(docker, ["rm", "-f", name]);
    return false;
  }
  const commit = await run(docker, ["commit", name, target]);
  await run(docker, ["rm", "-f", name]);
  if (commit.code !== 0) {
    console.error(
      `[${index}] ${task.instance_id}: commit failed: ${commit.out.trim().slice(-300)}`,
    );
    return false;
  }
  console.log(`[${index}] ${task.instance_id}: committed ${target}`);
  return true;
}

let next = 0;
let ok = 0;
async function worker() {
  while (next < tasks.length) {
    const index = next++;
    if (await prewarm(tasks[index], index)) ok += 1;
  }
}
await Promise.all(
  Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
);
console.log(`prewarm done: ${ok}/${tasks.length} ready`);
process.exit(ok === tasks.length ? 0 : 1);
