/**
 * request_transition — the engine's second intrinsic: the agent asks to move
 * phases (e.g. fix → verify once the suite is green).
 *
 * The tool itself only records the request; the ENGINE validates the target
 * against the strategy's phases and the strategy adjudicates against the
 * evidence log (`onTransitionRequest`) — the agent proposes, the evidence
 * disposes (decision #33). Injected only when a strategy accepts requests or
 * a phase advances on "agent_request", so other agents aren't distracted by it.
 */
import { defineTool, requireString } from "./types.js";

export const requestTransitionTool = defineTool(
  {
    name: "request_transition",
    description:
      "Ask to move to another phase of this run (e.g. from fix to verify once the full test " +
      "suite is green). The strategy checks the evidence and either moves you or rejects the " +
      "request with a reason. Use it when your current phase's work is done — it does not end " +
      "the run; finish() does.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: 'Target phase id (e.g. "verify").' },
        reason: { type: "string", description: "Why the move is justified — cite your evidence." },
      },
      required: ["to", "reason"],
      additionalProperties: false,
    },
  },
  async (input) => {
    const to = requireString(input, "to");
    const reason = requireString(input, "reason");
    return {
      ok: true,
      // The engine adjudicates and rewrites this content with the verdict.
      content: `transition request recorded (to "${to}")`,
      meta: { to, reason },
    };
  },
);
