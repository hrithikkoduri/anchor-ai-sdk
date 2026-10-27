/**
 * Multi-agent team definitions. A leader delegates one named task to one
 * worker. A worker is an instance of a roster member: the member is the role
 * (prompt + tools), the worker is who is doing it ("frontend-2"). Workers run
 * as nested engine loops in the same sandbox and return only a result; their
 * transcripts stay in the trace.
 *
 * Optional consumer seams make a crew rather than one-shot helpers:
 *   sessions  — a worker's conversation persists, so a later delegate to the
 *               same worker resumes it (fixes go back to whoever wrote it)
 *   workspace — where a worker works (a git worktree per writer), so writers
 *               can run in parallel without colliding
 * Delegations to different workers in one leader turn run concurrently;
 * delegations to the same worker are serialized.
 */
import type { Agent } from "../agents/types.js";
import type { ChildBudget } from "../engine/budgets.js";
import type { ThreadStore } from "../engine/thread.js";
import type { LLMClient } from "../llm/types.js";
import type { RepoRef } from "../repo.js";
import type { Sandbox } from "../sandbox/types.js";

export type TeamRole = "worker" | "evaluator";

export interface TeamMemberSpec {
  /** The named agent bundle (prompt + tools + optional model). */
  agent: Agent;
  role: TeamRole;
  /** One line shown to the leader in the delegate tool's roster. */
  description?: string;
  /**
   * Force the member's tool set to read-only tools. Evaluators are always
   * forced read-only (run_tests remains available).
   */
  readOnly?: boolean;
  /**
   * Per-member limits. Overridden by the `delegate` call's own `budget`; when
   * neither is given the child derives its budget from the leader's remaining
   * allowance (`deriveChildBudget`). A member limit may exceed the derived cap.
   */
  maxSteps?: number;
  maxTokens?: number;
  maxUsd?: number;
  /** Wall-clock ceiling in ms for this member, checked at turn boundaries. */
  maxWallClockMs?: number;
  /** Optional model override for this member. */
  llm?: LLMClient;
}

/** Where one delegated run works. Returned by `TeamSpec.workspace`. */
export interface TeamWorkspace {
  /**
   * The sandbox as this worker sees it, e.g. `scopedSandbox(sandbox, worktree)`:
   * file tools and commands resolve against its workspace, so a worker's
   * `edit_file("src/a.ts")` lands in its own tree. `repos` are relative to it.
   */
  sandbox?: Sandbox;
  /** Repositories as this worker sees them (relative to `sandbox`'s workspace when given). */
  repos?: RepoRef[];
  /** Appended to the child's task: its branch, path, what it starts from. */
  context?: string;
}

export interface TeamWorkspaceRequest {
  /** Worker instance name, e.g. "frontend-2". */
  worker: string;
  /** Roster member (role) name, e.g. "frontend". */
  member: string;
  role: TeamRole;
  readOnly: boolean;
  /** The leader's `base`: a branch or another worker to start from. */
  base?: string;
  /** True when this worker has delegated before (its workspace may exist). */
  resumed: boolean;
  /** The leader's `item`: the consumer's work item this delegation serves. */
  item?: string;
}

/** One delegation, as the consumer's admission check sees it before it runs. */
export interface TeamAdmissionRequest {
  worker: string;
  member: string;
  role: TeamRole;
  readOnly: boolean;
  task: string;
  /** The consumer's work item this delegation serves, if the leader named one. */
  item?: string;
  base?: string;
}

export type TeamAdmission = { ok: true } | { ok: false; reason: string };

export interface TeamSpec {
  /** The leader is opts.agent; these are the delegates it may call. */
  members: Record<string, TeamMemberSpec>;
  /**
   * Persist each worker's conversation. A later delegate to the same worker
   * resumes it; `fresh: true` starts over. Absent: every delegate is fresh.
   */
  sessions?: { store: ThreadStore; id: (worker: string) => string };
  /** Prepare where a worker works, before each delegated run. */
  workspace?: (request: TeamWorkspaceRequest) => Promise<TeamWorkspace | undefined>;
  /**
   * Decide whether a delegation may run at all, before any workspace or child
   * run exists. A refusal is the leader's tool result (its reason verbatim):
   * the consumer's plan, approvals and gates are enforced here, not trusted
   * to the leader's prompt.
   */
  admit?: (request: TeamAdmissionRequest) => Promise<TeamAdmission>;
  /** Most delegated runs in flight at once. Default 4. */
  maxParallel?: number;
}

export interface DelegateInput {
  /** Exact roster name (the role). */
  agent: string;
  /** Worker instance; defaults to the roster name. Same worker = same memory. */
  worker?: string;
  /** One bounded task. The child does not receive the parent transcript. */
  task: string;
  /** Optional compact context; never the full parent conversation. */
  context?: string;
  /** Optional evaluator feedback or repair notes for a follow-up call. */
  feedback?: string;
  /** A branch or another worker to start this worker's workspace from. */
  base?: string;
  /** The consumer's work item this delegation serves (a plan item id). */
  item?: string;
  /** Forget this worker's previous conversation and start over. */
  fresh?: boolean;
  /**
   * This child's own budget: any subset of `steps`, `wallClockMs`, `usd`.
   * Missing fields fall back to the member's limits and then to the derived
   * default; the child's spend rolls up into the leader's accounting and
   * never spends the leader's step allowance.
   */
  budget?: ChildBudget;
}

/** Valid worker names: short, lowercase, safe in a path or branch. */
export const WORKER_NAME = /^[a-z][a-z0-9-]{0,39}$/;
