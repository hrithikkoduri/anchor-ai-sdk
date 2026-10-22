/**
 * finish — the engine's terminal intrinsic: end the run with a summary, and
 * (optionally) a consumer-shaped handoff.
 *
 * NOT part of the tool registry: the engine injects it into every run
 * (decision #32), so consumers never list it. The loop treats an accepted
 * finish() as the terminal transition and reads everything through the tool
 * result's `meta`.
 *
 * The engine does not know what a handoff MEANS. When the consumer supplies
 * `EngineOptions.handoff.schema`, this tool declares a `handoff` parameter
 * with that schema (plus its description) and carries the model's object to
 * `AgentResult.handoff` untouched — the consumer interprets it. Without a
 * schema there is no handoff parameter, and passing one is a tool error.
 */
import { defineTool, optionalBoolean, requireString } from "./types.js";

export interface FinishOptions {
  /** Consumer-supplied JSON schema for the optional `handoff` parameter. */
  handoff?: { schema: Record<string, unknown>; description?: string };
  /**
   * Engine-owned pre-completion gate. Returning ok:false turns the finish call
   * into a failed tool result (the run continues) with actionable feedback.
   */
  validate?: (input: {
    summary: string;
    success: boolean;
    handoff?: Record<string, unknown>;
  }) => Promise<{ ok: false; content: string } | { ok: true }>;
}

export function createFinishTool(opts: FinishOptions = {}) {
  const handoff = opts.handoff;
  return defineTool(
    {
      name: "finish",
      description:
        "Optionally declare an outcome or handoff and end the turn. A normal final text response also ends the turn; this tool is not required. " +
        "State what happened and which checks actually ran, without claiming unobserved verification." +
        (handoff
          ? ` Optional handoff: ${handoff.description ?? "structured follow-up intent for the consumer."}`
          : ""),
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "What was done: files changed, how it was verified, anything left undone.",
          },
          success: {
            type: "boolean",
            description:
              "Your declared task outcome: true for completed work, false for blocked work. This is not test evidence or permission to publish.",
          },
          ...(handoff
            ? {
                handoff: {
                  ...handoff.schema,
                  description:
                    handoff.description ??
                    "Structured handoff for the consumer.",
                },
              }
            : {}),
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const summary = requireString(input, "summary");
      const success = optionalBoolean(input, "success") ?? true;
      const raw = input.handoff;
      if (raw !== undefined && !handoff)
        throw new Error(
          '"handoff" is not accepted on this run — the consumer configured no handoff schema',
        );
      if (
        raw !== undefined &&
        (typeof raw !== "object" || raw === null || Array.isArray(raw))
      )
        throw new Error('"handoff" must be an object');
      const handoffValue =
        raw !== undefined ? (raw as Record<string, unknown>) : undefined;
      if (opts.validate) {
        const verdict = await opts.validate({
          summary,
          success,
          ...(handoffValue ? { handoff: handoffValue } : {}),
        });
        if (!verdict.ok) return { ok: false, content: verdict.content };
      }
      ctx.onFinish?.(summary);
      return {
        ok: true,
        content: `finish recorded${success ? "" : " (reported as not successful)"} — the run will stop here.`,
        meta: {
          summary,
          success,
          ...(handoffValue !== undefined ? { handoff: handoffValue } : {}),
        },
      };
    },
  );
}

/** The bare finish tool (no handoff parameter) — for tooling and tests. */
export const finishTool = createFinishTool();
