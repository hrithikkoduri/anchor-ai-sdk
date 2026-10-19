/**
 * bash — the escape hatch. Full shell, the same one the agent starts with in
 * a microVM. Runs in the repo root by default (the sandbox adapter's doing);
 * self-contained per the tool-call contract.
 */
import { spillOrTruncate } from "./truncate.js";
import {
  defineTool,
  formatExec,
  optionalNumber,
  requireSandbox,
  requireString,
} from "./types.js";

export const bashTool = defineTool(
  {
    name: "bash",
    description:
      "Run a shell command inside the sandbox (starts in the repo root). " +
      "Commands are self-contained — cd/export do not persist between calls. " +
      "Use for git, ls, inspecting the environment, running scripts, installing packages.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        timeout_secs: {
          type: "integer",
          description: "Kill deadline in seconds (default 120, max 3600).",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  async (input, ctx) => {
    const command = requireString(input, "command");
    const explicit = optionalNumber(input, "timeout_secs", 0);
    const sandbox = requireSandbox(ctx);
    const threshold = ctx.backgroundAfterSecs;
    // Detach only when the consumer opted in AND this backend can hand back a
    // live job. An explicit short deadline stays a deadline (no detach).
    const canBackground =
      threshold !== undefined &&
      threshold > 0 &&
      typeof sandbox.pollJob === "function";
    // With background enabled, an unset timeout means "long-lived job": the
    // hard lifetime is the tool max, and `backgroundAfterSecs` is when the
    // model gets control back. Without it, the historical 120s default holds.
    const timeoutSecs = Math.max(
      1,
      Math.min(
        3600,
        explicit > 0 ? explicit : canBackground ? 3600 : 120,
      ),
    );
    const backgroundAfterSecs =
      canBackground && timeoutSecs > threshold ? threshold : undefined;
    const r = await sandbox.exec(command, {
      timeoutSecs,
      ...(backgroundAfterSecs !== undefined ? { backgroundAfterSecs } : {}),
    });
    if (r.background) {
      return {
        ok: true,
        verb: "Started a background command",
        content: [
          `Command is still running after ${backgroundAfterSecs}s — moved to the background (job ${r.background.jobId}).`,
          `Do NOT run it again. Its output will be delivered to you as a new message when it finishes.`,
          `Continue with other work, or end the turn; the harness will wake you with the result.`,
        ].join("\n"),
        meta: {
          command,
          background: r.background,
          durationMs: r.durationMs,
        },
      };
    }
    return {
      ok: r.exitCode === 0 && !r.timedOut,
      content: await spillOrTruncate(formatExec(r, timeoutSecs), {
        sandbox: ctx.sandbox,
        label: "bash",
      }),
      meta: {
        command,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        ...(r.failure ? { failure: r.failure } : {}),
      },
    };
  },
);
