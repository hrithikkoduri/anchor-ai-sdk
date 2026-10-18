/**
 * finish — the engine's terminal intrinsic: end the run with a summary, and
 * (optionally) declare what's next.
 *
 * NOT part of the tool registry: the engine injects it into every run
 * (decision #32), so consumers never list it. The loop treats an accepted
 * finish() as the terminal transition and reads everything through the tool
 * result's `meta` (the trace records it, the PR description uses it). Beyond `summary`/`success`:
 *
 *   disposition "done" | "watch" | "blocked"  — how the run concluded
 *   watch       product-defined spec          — e.g. { checks: true, comments: true }
 *   resumeAt    phase id                      — where a future run should start
 *
 * The engine only validates/carries these; products interpret them (this repo's
 * babysitter turns `watch` into scheduler registrations).
 */
import { defineTool, optionalBoolean, optionalString, requireString } from "./types.js";

const DISPOSITIONS = ["done", "watch", "blocked"] as const;

export const finishTool = defineTool(
  {
    name: "finish",
    description:
      "End the run. Call this exactly once, when the task is done or when you are " +
      "convinced you cannot proceed. The summary should state what changed and the " +
      "final test status. Optional follow-up intent: disposition=watch with " +
      "watch={checks:true,comments:true} and resumeAt=<phase> when a future run " +
      "should be woken by external signals (CI, review) and start at that phase.",
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
        disposition: {
          type: "string",
          enum: ["done", "watch", "blocked"],
          description:
            "How to conclude: done (default with success=true), watch (wake a follow-up run on " +
            "external signals), blocked (needs a human).",
        },
        watch: {
          type: "object",
          description: 'What to be woken for, e.g. {"checks": true, "comments": true}.',
        },
        resumeAt: {
          type: "string",
          description: 'Phase a future run on this thread should start at (e.g. "fix").',
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  async (input, ctx) => {
    const summary = requireString(input, "summary");
    const success = optionalBoolean(input, "success") ?? true;
    const disposition = optionalString(input, "disposition");
    if (disposition !== undefined && !(DISPOSITIONS as readonly string[]).includes(disposition)) {
      throw new Error(`"disposition" must be one of ${DISPOSITIONS.join(", ")}`);
    }
    const watch = input.watch;
    if (watch !== undefined && (typeof watch !== "object" || watch === null || Array.isArray(watch))) {
      throw new Error(`"watch" must be an object like {"checks": true}`);
    }
    const resumeAt = optionalString(input, "resumeAt");

    ctx.onFinish?.(summary);
    return {
      ok: true,
      content:
        `finish recorded${success ? "" : " (reported as not successful)"}` +
        `${disposition === "watch" ? " — concluding as watch" : ""} — the run will stop here.`,
      meta: {
        summary,
        success,
        ...(disposition !== undefined ? { disposition } : {}),
        ...(watch !== undefined ? { watch } : {}),
        ...(resumeAt !== undefined ? { resumeAt } : {}),
      },
    };
  },
);
