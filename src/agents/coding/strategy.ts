import type { AgentStrategy } from "../../engine/strategy.js";
import { buildRepoMap } from "./repomap.js";
import { codingPhases } from "./phases.js";
import { buildCodingPrompt } from "./prompts/index.js";

/** Guidance, not a mandatory itinerary. Product identity belongs to consumers. */
export const codingStrategy: AgentStrategy = {
  name: "coding",
  phases: codingPhases,
  requiresSandbox: true,
  requiredTools: ["bash", "read_file", "edit_file", "search", "run_tests"],
  prepareContext(sandbox) {
    if (!sandbox) throw new Error("codingStrategy requires a sandbox");
    return buildRepoMap(sandbox);
  },
  systemPrompt({ context, summary }) {
    return buildCodingPrompt({ context, summary });
  },
};
