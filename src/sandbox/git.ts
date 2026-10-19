/**
 * Git plumbing shared by every provider: checkpoints and the tree-vs-commit
 * comparison must behave identically on Docker, microVMs, and the dev backend.
 *
 * The loop trap of 2026-10-18 is sealed once, here: checkpoints legitimately
 * create commits at phase boundaries *without* changing content, so "new
 * commits ⇒ new work" is never a valid inference — `hasChangesFrom` compares
 * the staged tree against `ref^{tree}`, refreshes `origin/<branch>` refs
 * best-effort, and fails OPEN (true) when anything is unresolvable.
 *
 * Providers supply a `GitAccess` — how to run git and shell commands inside
 * their sandbox — and get identical semantics.
 */
import { shq, type Checkpoint, type ExecResult } from "./types.js";

/**
 * The reserved scratch dir INSIDE the repo. Git-excluded for normal status
 * and diffs (so it never pollutes a deliverable), but force-added to
 * checkpoints — the notes ride durability alongside the repo. Agents keep
 * their working notes at `<workspace>/.anchor/notes.md`.
 */
export const RESERVED_SCRATCH_DIR = ".anchor";
export const RESERVED_NOTES_PATH = `${RESERVED_SCRATCH_DIR}/notes.md`;

/**
 * Start-time prep (idempotent): keep `.anchor` out of git status/diff and
 * make sure the dir exists. Backends run this once the workspace is in place.
 */
export function reservedScratchPrepCommand(): string {
  return (
    `mkdir -p ${RESERVED_SCRATCH_DIR} && ` +
    `if [ -d .git ]; then ` +
    `(grep -qxF "${RESERVED_SCRATCH_DIR}/" .git/info/exclude 2>/dev/null || ` +
    `echo "${RESERVED_SCRATCH_DIR}/" >> .git/info/exclude); ` +
    `fi`
  );
}

export interface GitAccess {
  /**
   * Run `git <args…>` in the workspace directory. Resolves with stdout;
   * throws on non-zero exit with the command's output in the message.
   */
  git(args: string[], opts?: { timeoutSecs?: number }): Promise<string>;
  /** Run a shell command in the workspace; resolves with the full result. */
  shell(command: string, opts?: { timeoutSecs?: number }): Promise<ExecResult>;
}

/** Commit the workspace so the run can resume / fork from here. */
export async function checkpointVia(
  access: GitAccess,
  message: string,
  opts: { push?: string } = {},
): Promise<Checkpoint> {
  await access.git(["add", "-A"]);
  // The reserved notes file is git-excluded for status/diff but must ride
  // durability: force-add it (tolerant — it may not exist yet) so checkpoints
  // carry the agent's working memory alongside the repo.
  await access
    .shell(`git add -f ${RESERVED_NOTES_PATH} 2>/dev/null || true`)
    .catch(() => undefined);
  // --allow-empty: a checkpoint that changes nothing is still a valid point
  // to resume or fork from.
  await access.git(["commit", "-q", "--allow-empty", "-m", message]);
  const sha = (await access.git(["rev-parse", "HEAD"])).trim();

  const checkpoint: Checkpoint = { sha, message, at: Date.now() };
  if (opts.push) {
    // Off-machine durability; failures are reported, never thrown — the run
    // continues and the commit still exists in the sandbox.
    const push = await access.shell(
      `git push --force origin ${shq(`HEAD:refs/heads/${opts.push}`)}`,
      { timeoutSecs: 180 },
    );
    if (push.exitCode === 0) {
      checkpoint.pushedTo = opts.push;
    } else {
      checkpoint.pushError = push.output.trim().slice(0, 300);
      process.stderr.write(
        `checkpoint push to ${opts.push} failed: ${checkpoint.pushError}\n`,
      );
    }
  }
  return checkpoint;
}

/**
 * Does the workspace's CONTENT (git tree) differ from `ref`? Trees, never
 * commit lists — see the module comment. Any failure fails open → true
 * (assume there is work to deliver; never silently drop a delivery).
 */
export async function hasChangesFromVia(
  access: GitAccess,
  ref: string,
): Promise<boolean> {
  // Best-effort refresh of remote-tracking refs: a deleted branch or an
  // offline host must not break the comparison.
  if (ref.startsWith("origin/")) {
    const branch = ref.slice("origin/".length);
    await access
      .shell(
        `git fetch --quiet origin ${shq(`+refs/heads/${branch}:refs/remotes/${ref}`)}`,
        { timeoutSecs: 120 },
      )
      .catch(() => undefined);
  }

  let refTree = "";
  try {
    refTree = (
      await access.git(["rev-parse", "--verify", "--quiet", `${ref}^{tree}`], {
        timeoutSecs: 60,
      })
    ).trim();
  } catch {
    return true; // unresolvable ref → everything is new
  }
  if (!refTree) return true;

  // Stage first (same trick as the freshness checks): uncommitted work counts.
  const add = await access
    .shell("git add -A", { timeoutSecs: 120 })
    .catch(() => undefined);
  const localTree = await access
    .shell("git write-tree", { timeoutSecs: 60 })
    .catch(() => undefined);
  const localTreeSha = localTree?.stdout.trim() ?? "";
  if (add?.exitCode !== 0 || localTree?.exitCode !== 0 || !localTreeSha) {
    return true; // fail open
  }
  return localTreeSha !== refTree;
}
