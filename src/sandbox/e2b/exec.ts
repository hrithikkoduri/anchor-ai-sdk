/**
 * E2B result/command plumbing — pure functions so the adapter's behavior is
 * testable without a live account.
 *
 * The timeout rule is the repo-wide one: E2B's `timeoutMs` is a control-plane
 * deadline, not a promise that the guest process died. The command is wrapped
 * in coreutils `timeout -k` inside the sandbox, exactly like the Docker
 * backend, and exit 124/137 is reported as `timedOut`.
 */
import { shq, type ExecResult } from "../types.js";

/** The shape E2B's `commands.run()` returns (and `CommandExitError` carries). */
export interface E2BCommandResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * One self-contained command: switch to the workspace, then run the command
 * under a real kill deadline. E2B already runs `/bin/bash -l -c`, so this is
 * one extra `bash -c` specifically to make `timeout` the process-group owner.
 */
export function e2bCommand(
  command: string,
  cwd: string,
  timeoutSecs: number,
): string {
  return `cd ${shq(cwd)} && timeout -k 5 ${timeoutSecs} bash -c ${shq(command)}`;
}

/** Map E2B's result (or a thrown `CommandExitError`) onto the SDK's ExecResult. */
export function e2bResult(
  result: E2BCommandResult,
  startedAt: number,
  options: { output?: string } = {},
): ExecResult {
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : -1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = options.output ?? `${stdout}${stderr}`;
  const timedOut =
    exitCode === 124 ||
    exitCode === 137 ||
    /\btimed? ?out\b/i.test(result.error ?? "");
  return {
    exitCode,
    stdout,
    stderr,
    output,
    timedOut,
    durationMs: Date.now() - startedAt,
  };
}

/** A transport/RPC failure: the command's completion is unknown, not failed. */
export function e2bTransportFailure(
  message: string,
  startedAt: number,
): ExecResult {
  return {
    exitCode: -1,
    stdout: "",
    stderr: "",
    output: `E2B transport failure: ${message}`,
    timedOut: false,
    durationMs: Date.now() - startedAt,
    failure: {
      kind: "transport",
      completion: "unknown",
      message,
    },
  };
}

/**
 * Best-effort guest kill for a cancelled command. E2B has no kill-by-PID
 * API, so this pattern-kills by the command text (the run wraps it in
 * `bash -c <shq(command)>` — the literal single-quoted text identifies the
 * process). Fires-and-forget: a failure here must not mask the cancellation.
 */
export async function killE2bCommand(
  sandbox: {
    commands: {
      run(command: string, opts?: unknown): unknown;
    };
  },
  command: string,
): Promise<void> {
  try {
    await Promise.resolve(
      sandbox.commands.run(
        `pkill -f ${shq(command.slice(0, 200))} 2>/dev/null; printf killed`,
        { timeoutMs: 30_000 },
      ),
    );
  } catch {
    // The pattern-kill is best-effort; the guest-side `timeout -k` deadline
    // remains in force even if this control call fails.
  }
}
