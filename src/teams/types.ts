/**
 * Multi-agent team definitions. A leader delegates one named task to one
 * named roster member. The member runs as a nested engine loop in the same
 * sandbox and returns only a result; its transcript stays in the trace.
 */
import type { Agent } from "../agents/types.js";
import type { LLMClient } from "../llm/types.js";

export type TeamRole = "worker" | "evaluator";

export interface TeamMemberSpec {
  /** The named agent bundle (prompt + tools + optional model). */
  agent: Agent;
  role: TeamRole;
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

export interface TeamSpec {
  /** The leader is opts.agent; these are the delegates it may call. */
  members: Record<string, TeamMemberSpec>;
}

export interface DelegateInput {
  /** Exact roster name. */
  agent: string;
  /** One bounded task. The child does not receive the parent transcript. */
  task: string;
  /** Optional compact context; never the full parent conversation. */
  context?: string;
  /** Optional evaluator feedback or repair notes for a follow-up call. */
  feedback?: string;
}
