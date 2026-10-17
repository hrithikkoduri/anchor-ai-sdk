/**
 * The coding agent's toolbox — exactly the tools its strategy requires.
 *
 * Kept as an explicit list rather than `allTools`: an agent's capabilities
 * are a deliberate choice, so a tool added to the shared registry never
 * silently widens what this agent can do. A mismatch with
 * `codingStrategy.requiredTools` still fails fast at run startup.
 */
import type { Tool } from "../../tools/types.js";
import { bashTool } from "../../tools/bash.js";
import { editFileTool } from "../../tools/edit-file.js";
import { finishTool } from "../../tools/finish.js";
import { readFileTool } from "../../tools/read-file.js";
import { runTestsTool } from "../../tools/run-tests.js";
import { searchTool } from "../../tools/search.js";

export const codingTools: Tool[] = [bashTool, readFileTool, editFileTool, searchTool, runTestsTool, finishTool];
