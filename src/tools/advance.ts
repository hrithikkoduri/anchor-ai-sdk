/**
 * advance — the engine's second intrinsic: "I am done with this phase."
 *
 * Phases never advance on their own (decision #35). The agent drives every
 * move; the phase may carry an optional check (`validateAdvance`) that rules
 * on it — the agent proposes, the check disposes. No check = trusted, and the
 * move is recorded as unverified. In the final phase there is nothing to
 * advance to — `finish` ends the run.
 *
 * Injected only for multi-phase strategies (nothing to move to otherwise).
 * The tool itself only records the request; the engine validates the target
 * and runs the check.
 */
import { defineTool, optionalString } from "./types.js";

export const advanceTool = defineTool(
  {
    name: "advance",
    description:
      "Move on from the current phase (default: the next one; pass `to` to jump or go " +
      "back). The phase may validate the move and reject it with a reason. At the final " +
      "phase there is nothing to advance to — call finish() to end the run.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target phase id (default: the next phase)." },
        reason: { type: "string", description: "Why the move is justified — cite your evidence." },
      },
      additionalProperties: false,
    },
  },
  async (input) => {
    const to = optionalString(input, "to");
    const reason = optionalString(input, "reason");
    return {
      ok: true,
      // The engine validates the move and rewrites this content with the verdict.
      content: `advance recorded${to !== undefined ? ` (to "${to}")` : ""}`,
      meta: { ...(to !== undefined ? { to } : {}), ...(reason !== undefined ? { reason } : {}) },
    };
  },
);
