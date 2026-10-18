/**
 * The strategy contract — how an agent *behaves*, as data.
 *
 * The engine owns the mechanics (LLM ↔ tools, budgets, loop detection);
 * a strategy owns the phases, the prompts, and the optional checks that gate
 * moving on (`check`) and claiming success (`checkFinish`).
 * `codingStrategy` (reproduce → fix → verify) is the first implementation;
 * a research or triage agent would be another.
 */
import type { Sandbox } from "../sandbox/types.js";
import type { ToolResult } from "../tools/types.js";

/** One tool result as the strategy sees it when validating a finish claim. */
export interface ToolResultRecord {
  tool: string;
  ok: boolean;
  meta?: Record<string, unknown>;
}

/** The verdict a check returns — allow, or deny with a reason the model will see. */
export type CheckVerdict = { allow: boolean; reason?: string };

/**
 * What a phase's advance check sees. Checks are plain functions (decision
 * #37) — they may be async, may run their own verification in the sandbox,
 * and may call anything the host process can reach (an external approval
 * API, one of the tools, a judge). The AGENT never supplies checks; the
 * strategy does — so a check can do things the sandboxed agent cannot.
 */
export interface AdvanceCheckContext {
  to: string;
  reason?: string;
  evidence: ToolResultRecord[];
  /** The run's sandbox, when one exists — checks may execute their own verification. */
  sandbox?: Sandbox;
}

/**
 * What a strategy's finish check sees. Like advance checks, it may be async
 * and may use the sandbox to verify the success claim directly (decision #38).
 */
export interface FinishCheckContext {
  evidence: ToolResultRecord[];
  /** The run's sandbox, when one exists — the check may re-verify directly. */
  sandbox?: Sandbox;
}

export interface StrategyPhase {
  id: string;
  /** One line injected into the phase-entry message. */
  goal: string;
  /**
   * Soft turn budget for this phase. When exceeded, the engine nudges the
   * model once: "if you cannot {goal}, call finish(success=false)". This is
   * how "the bug cannot be reproduced" ends gracefully instead of burning to
   * the global step budget.
   */
  maxSteps?: number;
  /**
   * Optional check on the move OUT of this phase (the `advance` intrinsic).
   * The agent decides when a phase is done; this decides whether the move is
   * allowed — e.g. "only leave fix with a green full-suite run on record".
   * Absent = trusted: the move is allowed and recorded as unverified
   * (decision #34). The check is just a function (decision #37): it may be
   * async, use `ctx.sandbox` to run its own verification, or call anything
   * the host can reach (an external approval API, a tool, a judge). A
   * throwing check counts as a denial.
   */
  check?(ctx: AdvanceCheckContext): CheckVerdict | Promise<CheckVerdict>;
  /**
   * May the agent override a denial of this phase's check with
   * `advance({force: true})`? Default true — a check can delay a move, never
   * trap the loop (decision #36). `false` makes the gate absolute: satisfy
   * the check, or exit via `finish(success=false)` → blocked.
   */
  allowForce?: boolean;
}

export interface AgentStrategy {
  name: string;
  phases: StrategyPhase[];
  /**
   * Tool names this strategy's logic and prompts depend on. The engine
   * validates them against the supplied tool set at startup and refuses to
   * run when one is missing — a strategy/tool mismatch fails loudly instead
   * of confusing the model mid-run.
   */
  requiredTools?: string[];
  /** Whether a sandbox must be supplied. The engine validates this at startup; codingStrategy needs one, chatStrategy does not. */
  requiresSandbox?: boolean;
  /**
   * End the run when a turn produces text and no tool calls — the chat
   * semantic: the reply IS the completion. Default false; coding strategies
   * nudge instead, because they expect work rather than an answer.
   */
  finishWhenNoToolCalls?: boolean;
  /**
   * Optional orientation work before the first LLM call (e.g. a repo map).
   * The returned text goes into the system prompt; an explicit `RunTask.context`
   * takes precedence when both exist. `sandbox` is undefined for strategies
   * that don't require one.
   */
  prepareContext?(sandbox: Sandbox | undefined, task: string): Promise<string | undefined>;
  /**
   * Engine-enforced finish gate. Called when the model claims success; return
   * `{ allow: false, reason }` and the engine rejects the claim (the model
   * receives the reason as a tool error and the run continues). Like every
   * check, it may be async (decision #37). This is how "never claim success
   * without a passing full test run" becomes enforced rather than promised.
   */
  checkFinish?(ctx: FinishCheckContext): CheckVerdict | Promise<CheckVerdict>;
  /** The constant system prompt for the whole run. `summary` is the session's running summary, when one exists. */
  systemPrompt(args: { task: string; context?: string; summary?: string }): string;
  /** The message injected whenever a new phase begins. */
  enterPhaseMessage(phase: StrategyPhase): string;
}
