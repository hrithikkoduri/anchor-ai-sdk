/**
 * The tool registry — the five capability tools the agent gets, in one place.
 * `definitions()` feeds the model's function-calling API; `byName()` routes
 * the model's tool calls back to implementations.
 *
 * `finish` is deliberately NOT here: it is an engine intrinsic (decision #32),
 * injected into every run by the engine — consumers never list it. The tool
 * implementation still lives in ./finish.ts and is exported for tooling/tests.
 */
import { bashTool } from "./bash.js";
import { editFileTool } from "./edit-file.js";
import { readFileTool } from "./read-file.js";
import { runTestsTool } from "./run-tests.js";
import { searchTool } from "./search.js";
import type { Tool, ToolDefinition } from "./types.js";

export const allTools: Tool[] = [
  bashTool,
  readFileTool,
  editFileTool,
  searchTool,
  runTestsTool(),
];

// Individual capabilities — supply any subset to runAgent (the registry is the full set).
export { bashTool } from "./bash.js";
export { readFileTool } from "./read-file.js";
export { editFileTool } from "./edit-file.js";
export { searchTool } from "./search.js";
export { runTestsTool } from "./run-tests.js";
export {
  applyEdits,
  BATCH_MAX_OPS,
  BATCH_RENDER_CAPS,
  createBatchTool,
  parseBatch,
} from "./batch/index.js";
export type { BatchCacheOptions, BatchToolOptions, BatchUnit, OpReport, ParsedBatch, RenderCaps } from "./batch/index.js";
export { createViewImageTool } from "./view-image.js";
export type { ViewImageInput, ViewImageOptions } from "./view-image.js";
export { createSkillTools } from "./skills.js";
export type { SkillToolsOptions } from "./skills.js";
// Engine intrinsics — injected automatically; exported for tests/tooling only.
export { finishTool } from "./finish.js";

export function toolDefinitions(): ToolDefinition[] {
  return allTools.map((t) => t.definition);
}

export function toolByName(name: string): Tool | undefined {
  return allTools.find((t) => t.definition.name === name);
}

export { boundToolResult, spillOrTruncate, truncate, TOOL_RESULT_MAX_CHARS } from "./truncate.js";
export type { SpillTarget, TruncateOptions } from "./truncate.js";
export { toolVerb } from "./activity.js";
export {
  defineTool,
  formatExec,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireSandbox,
  requireString,
} from "./types.js";
export type {
  Tool,
  ToolContext,
  ToolDefinition,
  ToolEffect,
  ToolResult,
} from "./types.js";
