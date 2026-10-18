/** Agent behavior as data: prompts, capabilities, and meaningful work phases.
 * Phases describe an approach and its progress; they never gate execution or
 * completion. The agent may skip, revisit, or conclude from any phase. */
import type { Sandbox } from "../sandbox/types.js";

export interface ToolResultRecord {
  tool: string;
  ok: boolean;
  meta?: Record<string, unknown>;
}

export interface StrategyPhase {
  id: string;
  goal: string;
  guidance?: string;
}

export interface AgentStrategy {
  name: string;
  phases: StrategyPhase[];
  requiredTools?: string[];
  requiresSandbox?: boolean;
  prepareContext?(
    sandbox: Sandbox | undefined,
    task: string,
  ): Promise<string | undefined>;
  systemPrompt(args: {
    task: string;
    context?: string;
    summary?: string;
  }): string;
}
