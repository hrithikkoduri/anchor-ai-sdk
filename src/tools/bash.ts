/**
 * bash — the escape hatch. Full shell, the same one the agent starts with in
 * a microVM. Runs in the repo root by default (the sandbox adapter's doing);
 * self-contained per the tool-call contract.
 */
import { spillOrTruncate } from "./truncate.js";
import {
  defineTool,
  execPolicy,
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
      "Use for git, builds, tests, installs, and scripts. " +
      "Do not search or read text with it: use search to find text and read_file " +
      "to read files — they are read-only, and several in one turn run together.",
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
    // `background: true` is this tool's permission; execPolicy decides whether
    // the consumer opted in, the sandbox can poll, and the command outlives it.
    const { timeoutSecs, backgroundAfterSecs } = execPolicy(ctx, explicit);
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
          timeoutSecs,
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
  { background: true },
);
