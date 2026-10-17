import type { Agent } from "../types.js";
import { chatStrategy } from "./strategy.js";

export { chatStrategy } from "./strategy.js";

/** The zero-config default agent — replies; a text-only turn ends the run. */
export const chatAgent: Agent = { name: "chat", strategy: chatStrategy, tools: [] };
