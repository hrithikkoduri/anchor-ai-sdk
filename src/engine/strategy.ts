/**
 * The strategy contract — how an agent *behaves*, as data.
 *
 * The engine owns the mechanics (LLM ↔ tools, budgets, loop detection);
 * a strategy owns the phases, the prompts, and the evidence that advances a
 * phase. `codingStrategy` (reproduce → fix → verify) is the first
 * implementation; a research or triage agent would be another.
 */
import type { Sandbox } from "../sandbox/types.js";
import type { ToolResult } from "../tools/types.js";

/** One tool result as the strategy sees it when validating a finish claim. */
export interface ToolResultRecord {
  tool: string;
  ok: boolean;
  meta?: Record<string, unknown>;
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
   * Called after every tool result while this phase is active. Returning true
   * advances to the next phase. Phases are evidence-driven — the coding
   * strategy advances on a failing run_tests (reproduce) and a passing one
   * (fix) rather than on the model's say-so.
   */
  advanceOn?: (result: ToolResult, toolName: string) => boolean;
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
  /**
   * Optional orientation work before the first LLM call (e.g. a repo map).
   * The returned text goes into the system prompt; an explicit `RunTask.context`
   * takes precedence when both exist.
   */
  prepareContext?(sandbox: Sandbox, task: string): Promise<string | undefined>;
  /**
   * Engine-enforced finish gate. Called when the model claims success; return
   * `{ allow: false, reason }` and the engine rejects the claim (the model
   * receives the reason as a tool error and the run continues). This is how
   * "never claim success without a passing full test run" becomes enforced
   * rather than merely promised.
   */
  validateFinish?(evidence: ToolResultRecord[]): { allow: boolean; reason?: string };
  /** The constant system prompt for the whole run. `summary` is the session's running summary, when one exists. */
  systemPrompt(args: { task: string; context?: string; summary?: string }): string;
  /** The message injected whenever a new phase begins. */
  enterPhaseMessage(phase: StrategyPhase): string;
}
