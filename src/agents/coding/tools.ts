/**
 * The coding agent's toolbox — exactly the capability tools its strategy
 * requires. (`finish` is not here: it is an engine intrinsic, injected into
 * every run — decision #32.)
 *
 * Kept as an explicit list rather than `allTools`: an agent's capabilities
 * are a deliberate choice, so a tool added to the shared registry never
 * silently widens what this agent can do. A mismatch with
 * `codingStrategy.requiredTools` still fails fast at run startup.
 */
import type { Tool } from "../../tools/types.js";
import { bashTool } from "../../tools/bash.js";
import { editFileTool } from "../../tools/edit-file.js";
import { readFileTool } from "../../tools/read-file.js";
import { runTestsTool } from "../../tools/run-tests.js";
import { searchTool } from "../../tools/search.js";

/**
 * The toolbox for one coding agent. `testCommand` — when the repo's canonical
 * suite is known from config/CLI — becomes run_tests' fallback and counts as
 * full-suite evidence (publication policies gate on that distinction).
 */
export function createCodingTools(opts: { testCommand?: string } = {}): Tool[] {
  return [
    bashTool,
    readFileTool,
    editFileTool,
    searchTool,
    runTestsTool(opts.testCommand ? { defaultCommand: opts.testCommand } : {}),
  ];
}

/** The default toolbox — no configured suite; run_tests detects one. */
export const codingTools: Tool[] = createCodingTools();
