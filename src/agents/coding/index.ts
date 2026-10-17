import type { Agent } from "../types.js";
import { codingStrategy } from "./strategy.js";
import { codingTools } from "./tools.js";

export { codingStrategy } from "./strategy.js";
export { codingTools } from "./tools.js";

/** The built-in coding agent — codingStrategy + its toolbox in one import. */
export const codingAgent: Agent = { name: "coding", strategy: codingStrategy, tools: codingTools };
