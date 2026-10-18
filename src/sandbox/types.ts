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

/** VM size tiers (mirrors Heyo's size classes). */
export type HeyoSizeClass = "micro" | "mini" | "small" | "medium" | "large" | "xlarge";

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
}

export interface ExecOptions {
  /** Working directory for the command. Defaults to the sandbox workspace. */
  cwd?: string;
  /** Extra env vars for this command only (merged over the sandbox's env). */
  env?: Record<string, string>;
  /** Kill the command after this many seconds. Default 120, max 3600. */
  timeoutSecs?: number;
}

export interface Checkpoint {
  /** Git commit sha the workspace was checkpointed at. */
  sha: string;
  message: string;
  at: number;
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
  /** Survive destroy() — keep the sandbox around for debugging. */
  keep?: boolean;
}

export interface Sandbox {
  readonly id: string;
  readonly backend: "heyo" | "local";
  /** Absolute path of the repo inside the sandbox (e.g. /workspace/repo). */
  readonly workspace: string;

  /** Create the sandbox, get the repo into place, install toolchain bits. */
  start(): Promise<void>;
  /** Run one self-contained, time-bounded command. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Commit the workspace state so the run can resume / fork from here. */
  checkpoint(message: string): Promise<Checkpoint>;
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

/** Clamp a timeout into the supported range (matches Heyo's 1..3600 clamp). */
export function clampTimeout(secs: number | undefined): number {
  return Math.min(3600, Math.max(1, secs ?? 120));
}

/** Single-quote a string for a POSIX shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function newSandboxId(): string {
  return `sb-harness-${Math.random().toString(16).slice(2, 8)}${Date.now().toString(16).slice(-4)}`;
}
