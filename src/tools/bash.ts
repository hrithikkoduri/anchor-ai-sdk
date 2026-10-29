/**
 * bash — the escape hatch. Full shell, the same one the agent starts with in
 * a microVM. Runs in the repo root by default (the sandbox adapter's doing);
 * self-contained per the tool-call contract.
 */
import { commandKind } from "./batch/commands.js";
import { spillOrTruncate } from "./truncate.js";
import { resourceForRepo, selectRepo } from "./repo.js";
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
      "Run a shell command inside one named repository. " +
      "Commands are self-contained — cd/export do not persist between calls. " +
      "Omit repository only for a command that intentionally spans repositories; " +
      "such a call runs at the workspace root and, unless read-only, is serialized. " +
      "Use for git, builds, tests, installs, and scripts. " +
      "Do not search or read text with it: use search to find text and read_file " +
      "to read files — they are read-only, and several in one turn run together. " +
      "Independent read-only commands (git status/diff/log, ls, wc, stat) may be " +
      "issued together as separate bash calls in one turn; they run concurrently. " +
      "One call can answer several questions — a grep across several paths, one sed " +
      "over the files in scope — so do not spend a turn per file. " +
      "Commands that change files, and builds, installs, and test runs, stay in call order.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        repository: {
          type: "string",
          description:
            "Repository name (e.g. acme/api). Omit only for a spanning command.",
        },
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
    const repository =
      typeof input.repository === "string" ? input.repository : undefined;
    const selected = selectRepo(ctx, repository);
    if (selected.error) return { ok: false, content: selected.error };
    const explicit = optionalNumber(input, "timeout_secs", 0);
    const sandbox = requireSandbox(ctx);
    // `background: true` is this tool's permission; execPolicy decides whether
    // the consumer opted in, the sandbox can poll, and the command outlives it.
    const { timeoutSecs, backgroundAfterSecs } = execPolicy(ctx, explicit);
    const r = await sandbox.exec(command, {
      cwd: selected.cwd,
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
          ...(selected.repo ? { repository: selected.repo.name } : {}),
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
        ...(selected.repo ? { repository: selected.repo.name } : {}),
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        ...(r.failure ? { failure: r.failure } : {}),
      },
    };
  },
  {
    background: true,
    // Checks (tests, typecheck) are not reads here: they write caches and may bind ports.
    readOnlyWhen: (input) =>
      typeof input.command === "string" && commandKind(input.command) === "read",
    resource: (input, ctx) =>
      resourceForRepo(
        ctx,
        typeof input.repository === "string" ? input.repository : undefined,
      ),
  },
);
