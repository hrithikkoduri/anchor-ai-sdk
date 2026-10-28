/**
 * The sandbox abstraction: one isolated computer the agent works inside.
 *
 * ── TOOL-CALL CONTRACT ──────────────────────────────────────────────────────
 * Every command sent through `exec` MUST obey these rules. They exist because
 * of how the underlying VMs work (Heyo exec spawns a fresh process per call):
 *
 *   1. SELF-CONTAINED. No state survives between `exec` calls — no `cd`, no
 *      `export`, no background processes assumed alive. Every command starts
 *      with `cd <workspace> && …` or uses absolute paths. Adapters enforce
 *      this by wrapping commands themselves; tools must not rely on it.
 *
 *   2. TIME-BOUNDED. Every command has a real kill deadline. The adapter
 *      enforces it (guest-side `timeout` on Heyo — its own API timeout does
 *      NOT stop the guest process; process-group SIGTERM→SIGKILL on the
 *      local backend). A hung test suite must never wedge a run.
 *
 *   3. SECRETS AS ENV ONLY. Credentials enter the sandbox as environment
 *      variables (or /etc files on Heyo), never under the workspace, so no
 *      copy of the repo can leak them.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface ExecResult {
  /** Exit code. 124/137 conventionally mean "timed out / killed". -1 = could not run. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr interleaved, exactly as the command produced them. */
  output: string;
  /** True when the command hit its deadline and was killed. */
  timedOut: boolean;
  durationMs: number;
  /**
   * Set when the command outlived `ExecOptions.backgroundAfterSecs` and was
   * LEFT RUNNING in the sandbox. This is not a failure: `exitCode` is -1 only
   * because no exit exists yet. Read the real result later with
   * `Sandbox.pollJob(jobId)`; kill it with `Sandbox.killJob(jobId)`.
   */
  background?: { jobId: string };
  /** Transport failure is not a process exit or a confirmed command timeout. */
  failure?: {
    kind: "transport";
    completion: "unknown";
    jobId?: string;
    message: string;
  };
}

export interface ExecOptions {
  /** Working directory for the command. Defaults to the sandbox workspace. */
  cwd?: string;
  /** Extra env vars for this command only (merged over the sandbox's env). */
  env?: Record<string, string>;
  /** Kill the command after this many seconds. Default 120, max 3600. */
  timeoutSecs?: number;
  /**
   * Read-only commands may run alongside other exec calls. Mutations must
   * leave this unset: the adapter then waits/refuses rather than overlapping
   * an unresolved command. Set only for tools that cannot change the
   * workspace (read_file, search).
   */
  concurrent?: boolean;
  /**
   * Return control to the caller if the command is STILL RUNNING after this
   * many seconds, leaving the guest job alive in the sandbox (see
   * `ExecResult.background`). `timeoutSecs` remains the job's hard lifetime,
   * so it must be larger than this threshold.
   *
   * The sandbox must outlive the turn: the caller is responsible for keeping
   * it alive (retain/adopt) until it polls the job. Backends without detached
   * jobs ignore the option and run normally.
   */
  backgroundAfterSecs?: number;
}

export interface ProcessOptions {
  /** Working directory; defaults to the sandbox workspace. */
  cwd?: string;
  /** Extra environment for this process only. */
  env?: Record<string, string>;
  /** Hard lifetime; the process is killed at the deadline. */
  timeoutSecs?: number;
  /** Caller cancellation; also kills the process. */
  signal?: AbortSignal;
}

export interface ProcessHandle {
  /** Stable id for diagnostics and cleanup. */
  readonly id: string;
  /** Write bytes/UTF-8 to stdin, honoring backpressure. */
  write(data: string | Uint8Array): Promise<void>;
  /** Close stdin without killing stdout/stderr. */
  endInput(): Promise<void>;
  /** Readable output streams. Both are always present. */
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  /** Resolves on exit; rejects only on transport failure. */
  wait(): Promise<{ exitCode: number; signal?: string; timedOut: boolean }>;
  /** Kill the process group where possible. Idempotent. */
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<boolean>;
}

export interface PreviewEndpoint {
  /** Public/private URL that reaches the guest port. */
  url: string;
  /** The guest port that was exposed. */
  port: number;
}

export interface Checkpoint {
  /** Git commit sha the workspace was checkpointed at. */
  sha: string;
  message: string;
  at: number;
  /** Branch the commit was pushed to, when off-machine durability was asked for. */
  pushedTo?: string;
  /** Why the push failed — the checkpoint commit itself still exists in the sandbox. */
  pushError?: string;
}

export interface SandboxSpec {
  /** Git URL to clone into the workspace. */
  repoUrl?: string;
  /** Branch, tag, or commit sha to check out after cloning. */
  ref?: string;
  /**
   * Use an existing local directory as the repo instead of cloning
   * (local backend only — copies it, so edits never touch the original).
   */
  localPath?: string;
  /**
   * Environment for every command. Secrets travel here and only here.
   */
  env?: Record<string, string>;
  /**
   * The committer identity for checkpoints (default `anchor <anchor@localhost>`).
   * Consumers set their bot identity so commits are attributed correctly.
   */
  gitIdentity?: { name: string; email: string };
  /**
   * Git credentials for https clone/push. `token` is a CALLBACK, not a
   * string: provider tokens expire (GitHub installation tokens live ~1h) and
   * runs can outlive them — the sandbox re-resolves at every start/adopt.
   * `host` defaults to the repo URL's host (any git host works, not only
   * github.com); `username` defaults to the token's conventional user.
   */
  git?: {
    token: () => Promise<string> | string;
    host?: string;
    username?: string;
  };
  /** Survive destroy() — keep the sandbox around for debugging. */
  keep?: boolean;
  /**
   * Survive destroy() because the THREAD continues (distinct from `keep`, the
   * debugging switch): the next run on the thread adopts it by id — workspace,
   * branch, and uncommitted work exactly as left.
   *
   * destroy() of a retained sandbox detaches THIS run only; it never parks the
   * VM, because other runs may share it. Parking is the consumer's decision,
   * made when nobody is using the sandbox: `SandboxProvider.suspend(handle)`.
   * Providers keep an idle safety net (E2B pauses on timeout).
   */
  retain?: boolean;
  /**
   * Adopt a previously retained sandbox by id instead of creating a new one:
   * wakes the same VM (Heyo) or reuses the same directory (local). Throws from
   * start() when the retained sandbox is gone — callers then fall back to a
   * fresh sandbox built from `repoUrl`/`ref`.
   */
  adopt?: string;
  /**
   * The image for THIS sandbox, when the provider can vary it per sandbox.
   * Docker interprets it as a container image; E2B interprets it as a
   * template name or ID (E2B has no Docker-image-at-create); Heyo interprets
   * it as an artifact ref, but only when its configured `imageKind` is
   * `"artifact"` (dockerfile/git builds are provider-level). Local rejects it
   * loudly — silently dropping an image would run the wrong environment.
   */
  image?: string;
  /**
   * Egress for the AGENT phase only. `"none"` cuts the sandbox off after
   * `start()` completes, so setup (clone, pull, install) still has network but
   * the agent cannot fetch answers mid-run. Only providers declaring
   * `capabilities.egressControl` enforce it; the others REJECT `"none"` loudly
   * rather than run with network while a benchmark believes it is isolated.
   * Default `"full"`.
   */
  egress?: "full" | "none";
  /**
   * Use a directory that ALREADY EXISTS inside the sandbox as the workspace,
   * skipping clone/init — benchmark images arrive with the repo checked out
   * (e.g. `/testbed`). Distinct from `localPath`, which imports a directory
   * from the provider's own host. Unsupported providers reject it loudly.
   */
  workspacePath?: string;
}

export interface Sandbox {
  readonly id: string;
  readonly backend: string;
  /** Absolute path of the repo inside the sandbox (e.g. /workspace/repo). */
  readonly workspace: string;
  /**
   * A lifecycle-scoped scratch directory OUTSIDE the repo (spill files from
   * over-long outputs, agent notes). Survives retain/adopt with the sandbox;
   * never part of the deliverable diff. Backends: local `<root>/scratch`,
   * heyo `/workspace/.anchor`, docker `/tmp/anchor`. Consumers `mkdir -p` as
   * needed — nothing creates it eagerly.
   */
  readonly scratch: string;

  /** Create the sandbox, get the repo into place, install toolchain bits. */
  start(): Promise<void>;
  /** Run one self-contained, time-bounded command. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /**
   * Start a long-lived process with piped stdin/stdout/stderr. Optional: only
   * providers that declare capabilities.processStream implement it. No shell
   * interpolation — command and args are separate.
   */
  openProcess?(
    command: string,
    args: string[],
    opts?: ProcessOptions,
  ): Promise<ProcessHandle>;
  /**
   * Expose a guest port to the consumer. Optional: providers that cannot do
   * this omit it and declare `capabilities.previewPort: false`.
   */
  exposePort?(port: number): Promise<PreviewEndpoint>;
  /**
   * A backgrounded job's completion, or `undefined` while it is still
   * running. Throws when the job is unknown (already reaped, or the sandbox
   * was recreated). `meta` supplies the launch facts a fresh client does not
   * have (an adopted sandbox has no in-memory registry): the original start
   * time and the job's hard lifetime.
   */
  pollJob?(
    jobId: string,
    meta?: { startedAt?: number; timeoutSecs?: number },
  ): Promise<ExecResult | undefined>;
  /** Kill a backgrounded job (idempotent: false when it was already gone). */
  killJob?(jobId: string): Promise<boolean>;
  /**
   * Kill every guest job this sandbox still has, returning how many were
   * stopped. A leaked shell background child (`cmd &`) is not one the engine
   * tracks; draining before a checkpoint/diff keeps a benchmark from failing
   * on a busy sandbox instead of on the work. Best-effort by contract.
   */
  killAllJobs?(): Promise<number>;
  /** Commit the workspace state so the run can resume / fork from here.
   * With `push`, also force-push the commit to `refs/heads/<push>` so the
   * checkpoint survives losing the machine. A failed push is REPORTED in the
   * result (`pushError`), never thrown — durability is best-effort and must
   * not end a run. */
  checkpoint(message: string, opts?: { push?: string }): Promise<Checkpoint>;
  /**
   * Does this workspace's CONTENT (git tree) differ from `ref`?
   *
   * Compares TREES, never commit lists. Checkpoints create commits at phase
   * boundaries without changing content, so a consumer reacting to git
   * history (push delivery, CI triggers, webhooks) must never treat "new
   * commits" as "new work" — ask this instead. (Getting this wrong upstream
   * caused a push ↔ wake feedback loop, 2026-10-18: every acknowledgment
   * run's empty checkpoints were re-pushed as "new commits".)
   *
   * `origin/<branch>` refs are refreshed with a best-effort fetch first;
   * uncommitted working-tree changes count (the tree is staged). A ref that
   * can't be resolved, or any git failure, fails OPEN → `true` (assume there
   * is work to deliver — never silently drop a delivery).
   */
  hasChangesFrom(ref: string): Promise<boolean>;
  /**
   * Create a NEW sandbox whose workspace is a copy of this one at `ref`
   * (default: current HEAD). Uncommitted working-tree changes are NOT carried
   * over — a fork is a clean checkpoint state. The base primitive for
   * best-of-N races and for rebuild-from-checkpoint resumes.
   */
  fork(ref?: string): Promise<Sandbox>;
  /** Tear down (unless spec.keep). Must be safe to call twice. */
  destroy(): Promise<void>;
}

/**
 * The retained sandbox truly no longer exists — killed, expired and deleted,
 * or otherwise irrecoverable. An adapter throws this from `start()` on the
 * adopt path ONLY when it is certain the sandbox is gone, so a consumer may
 * safely drop its pointer and build a fresh one. A transient failure (a git
 * lock held by a concurrent opener, a control plane "transitioning", a
 * timeout) must NOT be reported as gone: retry it instead.
 */
export class SandboxGoneError extends Error {
  readonly sandboxId?: string;
  constructor(message: string, sandboxId?: string) {
    super(message);
    this.name = "SandboxGoneError";
    this.sandboxId = sandboxId;
  }
}

/**
 * The retained sandbox exists, but its workspace could not be confirmed after
 * retries — a resume still in progress, an unresponsive guest, a check that
 * timed out. NOT gone: the disk is still on record, so a consumer must not
 * clear its pointer or build a fresh sandbox over it. Retry later, or fail.
 */
export class WorkspaceUnavailableError extends Error {
  readonly sandboxId?: string;
  constructor(message: string, sandboxId?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceUnavailableError";
    this.sandboxId = sandboxId;
  }
}

/** True when an error means the sandbox truly no longer exists. */
export function isSandboxGone(error: unknown): boolean {
  return error instanceof SandboxGoneError;
}

/** Clamp a timeout into the supported range (matches Heyo's 1..3600 clamp). */
export function clampTimeout(secs: number | undefined): number {
  return Math.min(3600, Math.max(1, secs ?? 120));
}

/** Single-quote a string for a POSIX shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function newSandboxId(): string {
  return `sb-anchor-${Math.random().toString(16).slice(2, 8)}${Date.now().toString(16).slice(-4)}`;
}
