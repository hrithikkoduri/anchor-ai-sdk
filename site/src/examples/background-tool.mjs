import { defineTool, formatExec, requireSandbox, truncate } from "anchor-ai-sdk";

// A sandbox-exec tool, not a way to detach an arbitrary host-side Promise.
export const projectChecksTool = defineTool(
  {
    name: "project_checks",
    description: "Run the repository's npm test command. It may finish in the background.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  async (input, ctx) => {
    if (Object.keys(input).length) throw new Error("No parameters expected");
    const sandbox = requireSandbox(ctx);
    const command = "npm test";
    const timeoutSecs = 600; // hard command lifetime, independent of detach time
    const threshold = ctx.backgroundAfterSecs;
    // execPolicy is internal in 0.1.7. These are its public context fields.
    const canDetach = ctx.backgroundAllowed === true
      && typeof sandbox.pollJob === "function"
      && typeof threshold === "number" && Number.isFinite(threshold)
      && threshold > 0 && timeoutSecs > threshold;
    const result = await sandbox.exec(command, {
      timeoutSecs,
      ...(canDetach ? { backgroundAfterSecs: threshold } : {}),
    });
    if (result.background) {
      return {
        ok: true, // launch/detach accepted; this is NOT a passing-test result
        content: "Checks are running in the background. Do not launch them again; the engine will deliver their result.",
        meta: { command, timeoutSecs, background: result.background },
      };
    }
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      content: truncate(formatExec(result, timeoutSecs)),
      meta: {
        command, timeoutSecs, exitCode: result.exitCode, timedOut: result.timedOut,
        ...(result.failure ? { failure: result.failure } : {}),
      },
    };
  },
  { background: true, verb: "Running project checks" },
);
