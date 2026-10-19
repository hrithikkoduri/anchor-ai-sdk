/**
 * gitSnapshot — the default snapshot implementation: commit changed work
 * through the sandbox's own checkpoint machinery.
 *
 * The engine's snapshot hook exists so products can snapshot differently (a
 * remote push, an artifact store, another VCS). This is "the obvious thing"
 * for git-backed sandboxes: stage, commit, and — when given a branch —
 * force-push it for off-machine durability. Push failures come back on the
 * result, reported rather than thrown: a lost VM must not lose the run.
 */
import type { SnapshotFn } from "./types.js";

export function gitSnapshot(
  opts: { push?: string; message?: string } = {},
): SnapshotFn {
  return async ({ sandbox, reason }) => {
    if (!(await sandbox.hasChangesFrom("HEAD"))) return undefined;
    const checkpoint = await sandbox.checkpoint(
      opts.message ??
        (reason === "pause"
          ? "agent pause checkpoint"
          : "agent turn checkpoint"),
      opts.push ? { push: opts.push } : undefined,
    );
    return {
      ref: checkpoint.sha,
      ...(checkpoint.pushedTo ? { pushedTo: checkpoint.pushedTo } : {}),
      ...(checkpoint.pushError ? { pushError: checkpoint.pushError } : {}),
    };
  };
}
