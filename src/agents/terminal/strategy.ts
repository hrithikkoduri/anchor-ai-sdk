import type { AgentStrategy } from "../../engine/strategy.js";
import { terminalPhases } from "./phases.js";
import { buildTerminalPrompt } from "./prompt.js";

export const terminalStrategy: AgentStrategy = {
  name: "terminal",
  phases: terminalPhases,
  requiresSandbox: true,
  requiredTools: ["bash", "read_file", "edit_file"],
  systemPrompt({ context, summary }) {
    return buildTerminalPrompt({ context, summary });
  },
};
