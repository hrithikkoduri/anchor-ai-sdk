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
import { toPlainJson, toPlainJsonObject } from "../json.js";

export interface FinishOptions {
  /** Consumer-supplied JSON schema for the optional `handoff` parameter. */
  handoff?: { schema: Record<string, unknown>; description?: string };
  /**
   * A required, engine-validated `output` parameter (workflow bundles). The
   * tool only carries it; the engine's `validate` decides whether it is valid.
   */
  output?: { name: string; schema: Record<string, unknown>; description?: string };
  /**
   * Workflow mode: finish is the ONLY way the run ends, and every accepted
   * finish is a success. Replaces the description and drops `success`.
   */
  required?: boolean;
  /**
   * Engine-owned pre-completion gate. Returning ok:false turns the finish call
   * into a failed tool result (the run continues) with actionable feedback.
   */
  validate?: (input: {
    summary: string;
    success: boolean;
    handoff?: Record<string, unknown>;
    output?: unknown;
  }) => Promise<{ ok: false; content: string } | { ok: true }>;
}

export function createFinishTool(opts: FinishOptions = {}) {
  const handoff = opts.handoff;
  const output = opts.output;
  const required = opts.required === true;
  return defineTool(
    {
      name: "finish",
      description: required
        ? "End the run. This is the only way it ends: a prose reply does not. " +
          "It is accepted only after the run's check has passed in this run" +
          (output ? `, and only with a valid \`output\` (${output.name}).` : ".") +
          " State what was done and which checks actually ran."
        : "Optionally declare an outcome or handoff and end the turn. A normal final text response also ends the turn; this tool is not required. " +
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
          ...(required
            ? {}
            : {
                success: {
                  type: "boolean",
                  description:
                    "Your declared task outcome: true for completed work, false for blocked work. This is not test evidence or permission to publish.",
                },
              }),
          ...(output
            ? {
                output: {
                  ...output.schema,
                  description:
                    output.description ?? `The ${output.name} this run must return.`,
                },
              }
            : {}),
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
        required: output ? ["summary", "output"] : ["summary"],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const summary = requireString(input, "summary");
      if (required && input.success !== undefined)
        throw new Error('"success" is not accepted on this run — finish here always reports success');
      const success = required ? true : (optionalBoolean(input, "success") ?? true);
      if (input.output !== undefined && !output)
        throw new Error('"output" is not accepted on this run — it declares no output');
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
        raw !== undefined
          ? (raw as Record<string, unknown>)
          : undefined;
      if (opts.validate) {
        const verdict = await opts.validate({
          summary,
          success,
          ...(handoffValue ? { handoff: handoffValue } : {}),
          ...(output ? { output: input.output } : {}),
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
          ...(handoffValue !== undefined
            ? { handoff: toPlainJsonObject(handoffValue as object) }
            : {}),
          ...(output && input.output !== undefined
            ? { output: toPlainJson(input.output) }
            : {}),
        },
      };
    },
  );
}

/** The bare finish tool (no handoff parameter) — for tooling and tests. */
export const finishTool = createFinishTool();
