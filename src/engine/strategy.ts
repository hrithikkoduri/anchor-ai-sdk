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

export interface StrategyPhase {
  id: string;
  /** One line injected into the phase-entry message. */
  goal: string;
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
  /** The constant system prompt for the whole run. */
  systemPrompt(args: { task: string; context?: string }): string;
  /** The message injected whenever a new phase begins. */
  enterPhaseMessage(phase: StrategyPhase): string;
}
