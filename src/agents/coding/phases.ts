import type { StrategyPhase } from "../../engine/strategy.js";

/** A useful engineering approach, not a gated itinerary. The agent decides
 * which phases apply, may skip/revisit them, and may conclude from any phase. */
export const codingPhases: StrategyPhase[] = [
  {
    id: "understand",
    goal: "Establish the current request, its scope, and the relevant facts.",
    guidance:
      "Inspect the real repository and prior observations. Distinguish a review, an explanation, a scope correction, and an implementation request. Ask only when a meaningful ambiguity blocks safe progress.",
  },
  {
    id: "act",
    goal: "Carry out the requested work with the smallest sound intervention.",
    guidance:
      "For a review, inspect the change and develop findings; do not silently edit. For implementation, make focused changes. Reconsider the approach when evidence or user direction changes.",
  },
  {
    id: "validate",
    goal: "Gather evidence appropriate to the change and its risks.",
    guidance:
      "Use relevant existing tests for executable behavior, inspect diffs, and check documentation against source facts. Do not invent tests, no-op scripts, or test infrastructure to satisfy a process. Report unavailable or inapplicable checks honestly.",
  },
  {
    id: "respond",
    goal: "Deliver the answer, findings, or outcome with evidence and limitations.",
    guidance:
      "Be clear about what happened, what was verified, and what remains uncertain. A response does not publish code or post a GitHub comment. End when the request is answered or a genuine blocker needs the user.",
  },
];
