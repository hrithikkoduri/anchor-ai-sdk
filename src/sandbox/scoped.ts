/**
 * A view of a sandbox rooted at one of its directories. Commands and file
 * tools default to that directory, so an agent given the view works there —
 * a crew worker in its own git worktree, for instance. The view does not own
 * the sandbox: starting or destroying it does nothing to the real one.
 */
import path from "node:path";
import type { Sandbox } from "./types.js";

export function scopedSandbox(sandbox: Sandbox, dir: string): Sandbox {
  const root = path.posix.isAbsolute(dir) ? dir : path.posix.join(sandbox.workspace, dir);
  const view: Sandbox = {
    id: sandbox.id,
    backend: sandbox.backend,
    workspace: root,
    scratch: sandbox.scratch,
    start: async () => undefined,
    exec: (command, opts = {}) => sandbox.exec(command, { ...opts, cwd: opts.cwd ?? root }),
    checkpoint: (message, opts) => sandbox.checkpoint(message, opts),
    hasChangesFrom: (ref) => sandbox.hasChangesFrom(ref),
    fork: (ref) => sandbox.fork(ref),
    destroy: async () => undefined,
    ...(sandbox.openProcess
      ? { openProcess: (command, args, opts = {}) => sandbox.openProcess!(command, args, { ...opts, cwd: opts.cwd ?? root }) }
      : {}),
    ...(sandbox.exposePort ? { exposePort: (port) => sandbox.exposePort!(port) } : {}),
    ...(sandbox.pollJob ? { pollJob: (jobId, meta) => sandbox.pollJob!(jobId, meta) } : {}),
    ...(sandbox.killJob ? { killJob: (jobId) => sandbox.killJob!(jobId) } : {}),
    ...(sandbox.killAllJobs ? { killAllJobs: () => sandbox.killAllJobs!() } : {}),
  };
  return view;
}
