import type { Agent } from "../types.js";
import { createCodingTools } from "../coding/tools.js";
import { terminalStrategy } from "./strategy.js";

export { terminalStrategy } from "./strategy.js";
export { terminalPhases } from "./phases.js";
export { buildTerminalPrompt } from "./prompt.js";

export function createTerminalAgent(opts: {
  maxOutputTokens?: number | false;
  reasoningEffort?: Agent["reasoningEffort"];
} = {}): Agent {
  return {
    name: "terminal",
    strategy: terminalStrategy,
    tools: createCodingTools(),
    ...(opts.maxOutputTokens !== undefined
      ? { maxOutputTokens: opts.maxOutputTokens }
      : {}),
    ...(opts.reasoningEffort !== undefined
      ? { reasoningEffort: opts.reasoningEffort }
      : {}),
  };
}

export const terminalAgent: Agent = createTerminalAgent();
