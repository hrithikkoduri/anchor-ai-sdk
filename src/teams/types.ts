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
import type { ThreadStore } from "../engine/thread.js";
import type { LLMClient } from "../llm/types.js";
import type { RepoRef } from "../repo.js";

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
  /** Per-member limits; absent members inherit the run limits. */
  maxSteps?: number;
  maxTokens?: number;
  maxUsd?: number;
  /** Optional model override for this member. */
  llm?: LLMClient;
}

/** Where one delegated run works. Returned by `TeamSpec.workspace`. */
export interface TeamWorkspace {
  /** Repositories as this worker sees them (e.g. paths inside its worktree). */
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
}

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
  /** Forget this worker's previous conversation and start over. */
  fresh?: boolean;
}

/** Valid worker names: short, lowercase, safe in a path or branch. */
export const WORKER_NAME = /^[a-z][a-z0-9-]{0,39}$/;
