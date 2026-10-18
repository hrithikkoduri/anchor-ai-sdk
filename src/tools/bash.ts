/**
 * bash — the escape hatch. Full shell, the same one the agent starts with in
 * a microVM. Runs in the repo root by default (the sandbox adapter's doing);
 * self-contained per the tool-call contract.
 */
import { truncate } from "./truncate.js";
import { defineTool, formatExec, optionalNumber, requireSandbox, requireString } from "./types.js";

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
    const timeoutSecs = Math.max(1, Math.min(3600, optionalNumber(input, "timeout_secs", 120)));
    const sandbox = requireSandbox(ctx);
    const r = await sandbox.exec(command, { timeoutSecs });
    return {
      ok: r.exitCode === 0 && !r.timedOut,
      content: truncate(formatExec(r, timeoutSecs)),
      meta: { command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, ...(r.failure ? { failure: r.failure } : {}) },
    };
  },
);
