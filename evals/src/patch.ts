/**
 * Agent-patch capture that distinguishes agent work from the environment.
 *
 * SWE-bench Pro images ship untracked runtime artifacts (NodeBB's Redis AOF
 * directory is one). Staging `git add -A` would turn those pre-existing files
 * into "new files" in the agent patch; replaying that patch in a pristine
 * image then fails with "already exists in working directory". Capture the
 * pre-run untracked set and add only files the agent actually created.
 */
import type { Sandbox } from "anchor-ai-sdk";

const EXCLUDE_SCRATCH = "':(exclude).anchor'";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function untrackedFiles(sandbox: Sandbox): Promise<string[]> {
  const result = await sandbox.exec(
    "git ls-files --others --exclude-standard -z",
    { timeoutSecs: 60, concurrent: true },
  );
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\0").filter(Boolean);
}

export async function extractPatch(
  sandbox: Sandbox,
  headRef: string,
  baselineUntracked: readonly string[],
): Promise<string> {
  const tracked = await sandbox.exec(
    `git diff --binary ${headRef} -- . ${EXCLUDE_SCRATCH}`,
    { timeoutSecs: 180, concurrent: true },
  );
  if (tracked.exitCode !== 0) {
    throw new Error(
      `patch extraction failed (git diff exited ${tracked.exitCode}): ${tracked.output.trim().slice(0, 300)}`,
    );
  }
  const baseline = new Set(baselineUntracked);
  const current = await untrackedFiles(sandbox);
  const created = current.filter(
    (file) => !baseline.has(file) && !file.startsWith(".anchor/"),
  );
  let patch = tracked.stdout;
  for (const file of created) {
    // `git diff --no-index` exits 1 when the files differ; that is the
    // success case for a new untracked file.
    const diff = await sandbox.exec(
      `git diff --no-index --binary /dev/null ${quote(file)}`,
      { timeoutSecs: 120, concurrent: true },
    );
    if (diff.exitCode === 0) continue;
    if (diff.exitCode !== 1) {
      throw new Error(
        `patch extraction failed for ${file} (git diff --no-index exited ${diff.exitCode}): ${diff.output.trim().slice(0, 300)}`,
      );
    }
    patch += diff.stdout;
  }
  return patch;
}
