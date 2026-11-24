/**
 * Checkpoint, then resume: the durability path, as a runnable file.
 *
 *   OPENROUTER_KEY=... node examples/checkpoint-resume.mjs
 *   OPENROUTER_KEY=... node examples/checkpoint-resume.mjs https://github.com/acme/app.git
 *
 * Run 1 edits a repo in a local sandbox; the turn-boundary checkpoint is
 * force-pushed to the `anchor-checkpoint` branch. Run 2 opens a FRESH sandbox
 * (a new clone, not the retained one) at that pushed branch, with the same
 * ThreadStore, and checks the edits are there. Same workspace, same
 * conversation.
 *
 * There is no resume-from-checkpoint API: a checkpoint is a git commit, so
 * resuming is "open a sandbox at the pushed branch and run again".
 *
 * ## Why the pushed branch comes from the event, not from the result
 *
 * `AgentResult.checkpointRef` is the commit sha and nothing else. Whether the
 * push left the machine is reported only on the `checkpoint` event
 * (`pushedTo`, `pushError`), and a failed push is NOT fatal: the run still
 * ends `ok: true` with a `checkpointRef` whose commit exists only in that
 * sandbox. A caller that does not subscribe to `onEvent` cannot tell
 * durability from a lost checkpoint.
 *
 * ## Which `spec.ref` string form works after a fresh clone (now confirmed)
 *
 * The push writes `refs/heads/<push>`; `start()` clones and then runs
 * `git checkout <ref>` (src/sandbox/local/index.ts:133-135, and the same in
 * docker/index.ts:183-190). Checked against a bare origin with a plain
 * `git clone`:
 *
 *   ref: "anchor-checkpoint"            -> works, lands ON the branch   [use this]
 *   ref: "origin/anchor-checkpoint"     -> works, but detached HEAD
 *   ref: "refs/heads/anchor-checkpoint" -> fails: "pathspec ... did not match"
 *
 * So pass the branch name bare, exactly the string handed to
 * `gitSnapshot({ push })`. A sha would also check out (detached), but a branch
 * name survives a later checkpoint overwriting the branch; a sha pins one.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  codingAgent,
  gitSnapshot,
  llmFromCatalog,
  MemoryThreadStore,
  runAgent,
  userTurn,
} from "anchor-ai-sdk";
import { local } from "anchor-ai-sdk/sandbox/local";

const BRANCH = "anchor-checkpoint";
// Absolute, and outside the repo: the sandbox clones with cwd inside its own
// scratch dir, so a relative repoUrl would resolve there instead of here.
const WORK = path.join(os.tmpdir(), "anchor-checkpoint-resume");
const gitIdentity = { name: "anchor-example", email: "anchor@example.invalid" };

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** No credentials needed: a bare repo on this machine as the origin. */
async function localOrigin(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const seed = path.join(dir, "seed");
  const origin = path.join(dir, "origin.git");
  git(["init", "-q", "-b", "main", seed]);
  await writeFile(path.join(seed, "README.md"), "# checkpoint-resume fixture\n");
  git(["-C", seed, "add", "-A"]);
  git([
    "-C", seed,
    "-c", `user.name=${gitIdentity.name}`,
    "-c", `user.email=${gitIdentity.email}`,
    "commit", "-qm", "seed commit",
  ]);
  git(["clone", "-q", "--bare", seed, origin]);
  await rm(seed, { recursive: true, force: true });
  return origin;
}

const apiKey = process.env.OPENROUTER_KEY;
if (!apiKey) {
  console.error("Set OPENROUTER_KEY (any OpenAI-compatible provider works).");
  process.exit(1);
}
const { llm } = await llmFromCatalog({
  baseUrl: process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
  apiKey,
  model: process.env.MODEL ?? "z-ai/glm-5.3",
});

const repoUrl = process.argv[2] ?? (await localOrigin(path.join(WORK, "origin")));
const provider = local({ rootDir: path.join(WORK, "sandboxes") });
const store = new MemoryThreadStore();
const threadId = "checkpoint-resume";

// --- run 1: do work, push the turn-boundary checkpoint ----------------------
const sandbox = provider.create({ repoUrl, ref: "main", gitIdentity });
await sandbox.start();

let checkpoint;
let pushError;
let result1;
try {
  result1 = await runAgent(
    userTurn(
      "In the repository root, create checkpoint-proof.txt containing exactly the line: round one. " +
        "Use the bash tool. Do not run git add, git commit, or git push.",
    ),
    {
      llm,
      agent: codingAgent,
      sandbox,
      thread: { store, id: threadId },
      snapshot: gitSnapshot({ push: BRANCH }),
      onEvent(event) {
        if (event.type !== "checkpoint") return;
        checkpoint = event;
        pushError = event.pushError;
        console.log(
          `checkpoint ${event.ref.slice(0, 12)}` +
            (event.pushedTo ? ` -> pushed to ${event.pushedTo}` : " (not pushed)") +
            (event.pushError ? ` (push failed: ${event.pushError})` : ""),
        );
      },
      budgets: { maxSteps: 12, maxUsd: 0.5 },
    },
  );
} finally {
  await sandbox.destroy();
}

// No durable checkpoint is a FAILURE of the documented path, reported as such.
if (pushError) {
  console.error(`push to ${BRANCH} failed: ${pushError}`);
  process.exit(1);
}
if (!checkpoint?.pushedTo) {
  console.error(
    [
      "",
      "NO DURABLE CHECKPOINT: the run finished without pushing.",
      `  reason: ${result1.reason}  ok: ${result1.ok}  checkpointRef: ${result1.checkpointRef ?? "(none)"}`,
      "  gitSnapshot() skips an unchanged tree, so the agent either changed",
      "  nothing or committed the work itself (tree == HEAD) — nothing to push.",
    ].join("\n"),
  );
  process.exit(1);
}

// --- run 2: a fresh sandbox at the pushed branch ---------------------------
const resumed = provider.create({ repoUrl, ref: checkpoint.pushedTo, gitIdentity });
await resumed.start();
try {
  const head = (await resumed.exec("git rev-parse HEAD")).stdout.trim();
  const onBranch = (await resumed.exec("git rev-parse --abbrev-ref HEAD")).stdout.trim();
  const files = (await resumed.exec(`git ls-tree -r --name-only ${checkpoint.ref}`)).stdout
    .split("\n")
    .filter(Boolean);
  const proof = await resumed.exec("cat checkpoint-proof.txt");

  const before = await store.load(threadId);
  console.log(`resumed at ${checkpoint.pushedTo} (${head.slice(0, 12)}, on ${onBranch})`);
  console.log(`checkpoint commit reachable: ${head === checkpoint.ref}`);
  console.log(`thread before run 2: ${before?.messages.length ?? 0} messages`);
  console.log(`files at the checkpoint: ${files.join(", ")}`);

  const result2 = await runAgent(
    userTurn("Quote the contents of checkpoint-proof.txt from the repo root."),
    {
      llm,
      agent: codingAgent,
      sandbox: resumed,
      thread: { store, id: threadId },
      budgets: { maxSteps: 12, maxUsd: 0.5 },
    },
  );

  console.log(`\n${result2.summary ?? "(no summary)"}\n`);

  const checks = [
    ["run 2 sandbox is at the checkpoint commit", head === checkpoint.ref],
    ["run 1's edit exists in run 2", proof.exitCode === 0 && proof.stdout.includes("round one")],
    ["run 1's edit is committed, not just on disk", files.includes("checkpoint-proof.txt")],
    ["same thread was loaded", (before?.messages.length ?? 0) > 0],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exit(1);
} finally {
  await resumed.destroy();
}
