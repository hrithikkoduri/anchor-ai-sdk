import type { Agent } from "../types.js";
import { codingStrategy } from "./strategy.js";
import { createCodingTools, codingTools } from "./tools.js";

export { codingStrategy } from "./strategy.js";
export { createCodingTools, codingTools } from "./tools.js";
export {
  buildCodingPrompt,
  character,
  codingPromptComponents,
  judgment,
  operatingRules,
  tone,
  verification,
} from "./prompts/index.js";
export type { CodingPromptOptions } from "./prompts/index.js";
export { codingPhases } from "./phases.js";

/**
 * The coding agent — strategy + toolbox. Pass `testCommand` when the repo's
 * canonical suite is known (CLI or repo config); otherwise run_tests detects
 * one; either way run_tests tags the run as the repo's full-suite evidence.
 *
 * `maxOutputTokens` overrides the engine's per-call cap for this bundle (see
 * #75). Left unset, the engine default governs; an explicit
 * `EngineOptions.maxOutputTokens` still wins.
 */
export function createCodingAgent(
  opts: {
    testCommand?: string;
    maxOutputTokens?: number | false;
    reasoningEffort?: Agent["reasoningEffort"];
  } = {},
): Agent {
  return {
    name: "coding",
    strategy: codingStrategy,
    tools: createCodingTools(opts),
    ...(opts.maxOutputTokens !== undefined
      ? { maxOutputTokens: opts.maxOutputTokens }
      : {}),
    ...(opts.reasoningEffort !== undefined
      ? { reasoningEffort: opts.reasoningEffort }
      : {}),
  };
}

/** The zero-config coding agent — detection instead of a configured suite. */
export const codingAgent: Agent = createCodingAgent();
