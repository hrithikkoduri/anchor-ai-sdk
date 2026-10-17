/**
 * The tool registry — the six tools the agent gets, in one place.
 * `definitions()` feeds the model's function-calling API; `byName()` routes
 * the model's tool calls back to implementations.
 */
import { bashTool } from "./bash.js";
import { editFileTool } from "./edit-file.js";
import { finishTool } from "./finish.js";
import { readFileTool } from "./read-file.js";
import { runTestsTool } from "./run-tests.js";
import { searchTool } from "./search.js";
import type { Tool, ToolDefinition } from "./types.js";

export const allTools: Tool[] = [bashTool, readFileTool, editFileTool, searchTool, runTestsTool, finishTool];

export function toolDefinitions(): ToolDefinition[] {
  return allTools.map((t) => t.definition);
}

export function toolByName(name: string): Tool | undefined {
  return allTools.find((t) => t.definition.name === name);
}

export { truncate } from "./truncate.js";
export type { Tool, ToolContext, ToolDefinition, ToolResult } from "./types.js";
