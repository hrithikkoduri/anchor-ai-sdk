import type { Agent } from "../types.js";
import { codingStrategy } from "./strategy.js";
import { createCodingTools, codingTools } from "./tools.js";

export { codingStrategy } from "./strategy.js";
export { createCodingTools, codingTools } from "./tools.js";
export { buildCodingPrompt } from "./prompts/index.js";
export type { CodingPromptOptions } from "./prompts/index.js";
export { codingPhases } from "./phases.js";

/**
 * The coding agent — strategy + toolbox. Pass `testCommand` when the repo's
 * canonical suite is known (CLI or repo config); otherwise run_tests detects
 * one and the evidence gates still apply.
 */
export function createCodingAgent(opts: { testCommand?: string } = {}): Agent {
  return {
    name: "coding",
    strategy: codingStrategy,
    tools: createCodingTools(opts),
  };
}

/** The zero-config coding agent — detection instead of a configured suite. */
export const codingAgent: Agent = createCodingAgent();
