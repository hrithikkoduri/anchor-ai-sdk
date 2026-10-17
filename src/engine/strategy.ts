/**
 * The strategy contract — how an agent *behaves*, as data.
 *
 * The engine owns the mechanics (LLM ↔ tools, budgets, loop detection);
 * a strategy owns the phases, the prompts, and the evidence that advances a
 * phase. `codingStrategy` (reproduce → fix → verify) is the first
 * implementation; a research or triage agent would be another.
 */
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
  /** The constant system prompt for the whole run. */
  systemPrompt(args: { task: string; context?: string }): string;
  /** The message injected whenever a new phase begins. */
  enterPhaseMessage(phase: StrategyPhase): string;
}
