/**
 * finish — end the run with a summary.
 *
 * The loop treats a finish() call as the terminal transition; ctx.onFinish
 * carries the summary out (the trace records it, the PR description uses it).
 */
import { defineTool, optionalBoolean, requireString } from "./types.js";

export const finishTool = defineTool(
  {
    name: "finish",
    description:
      "End the run. Call this exactly once, when the task is done or when you are " +
      "convinced you cannot proceed. The summary should state what changed and the " +
      "final test status.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "What was done: files changed, how it was verified, anything left undone.",
        },
        success: {
          type: "boolean",
          description: "true if the task was completed and verified; false if blocked or unverified.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  async (input, ctx) => {
    const summary = requireString(input, "summary");
    const success = optionalBoolean(input, "success") ?? true;
    ctx.onFinish?.(summary);
    return {
      ok: true,
      content: `finish recorded${success ? "" : " (reported as not successful)"} — the run will stop here.`,
      meta: { summary, success },
    };
  },
);
