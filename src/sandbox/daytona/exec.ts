/**
 * Daytona result/command plumbing — pure functions so the adapter's behavior is
 * testable without a live account.
 *
 * Two Daytona facts shape this file, both verified against the live API:
 *
 * 1. `process.executeCommand()` returns stderr merged into `result`, so it
 *    cannot carry `ExecResult`'s stream fidelity. A **session** command
 *    (`executeSessionCommand`) returns `stdout`, `stderr`, and `exitCode`
 *    separately; that is the transport `exec()` uses.
 * 2. Daytona's per-command `timeout` is a control-plane deadline, not a
 *    promise the guest process died. The command is wrapped in coreutils
 *    `timeout -k` inside the sandbox, exactly like the Docker and E2B
 *    backends, and exit 124/137 is reported as `timedOut`.
 */
import { shq, type ExecResult } from "../types.js";

/** The shape a Daytona session command reports. */
export interface DaytonaCommandResult {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  output?: string;
}

/**
 * One self-contained command: switch to the workspace, apply the call's env,
 * then run the command under a real kill deadline.
 *
 * `env` is layered by the caller into per-call values merged over the spec's;
 * it is passed with `env(1)` rather than `VAR=value` prefixes so a value with
 * quotes or spaces cannot reshape the command. The inner shell string is ONE
 * quoted argv element, so the caller's text is never re-parsed.
 */
export function daytonaCommand(
  command: string,
  cwd: string,
  timeoutSecs: number,
  env: Record<string, string> = {},
): string {
  const assigns = Object.entries(env)
    .map(([key, value]) => shq(`${key}=${value}`))
    .join(" ");
  const envPart = assigns ? `env ${assigns} ` : "";
  return (
    `cd ${shq(cwd)} && ` +
    `timeout -k 5 ${timeoutSecs} ${envPart}bash -c ${shq(command)}`
  );
}

/**
 * Map a session command's result onto the SDK's ExecResult.
 *
 * `output` is the stream order Daytona recorded when it provides one; otherwise
 * stdout followed by stderr (Daytona does not interleave the two for a finished
 * command, so this is the honest fallback rather than an invented order).
 */
export function daytonaResult(
  result: DaytonaCommandResult,
  startedAt: number,
): ExecResult {
  const exitCode =
    typeof result.exitCode === "number" ? result.exitCode : -1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = result.output || `${stdout}${stderr}`;
  return {
    exitCode,
    stdout,
    stderr,
    output,
    timedOut: exitCode === 124 || exitCode === 137,
    durationMs: Date.now() - startedAt,
  };
}

/** A transport/RPC failure: the command's completion is unknown, not failed. */
export function daytonaTransportFailure(
  message: string,
  startedAt: number,
): ExecResult {
  return {
    exitCode: -1,
    stdout: "",
    stderr: "",
    output: `Daytona transport failure: ${message}`,
    timedOut: false,
    durationMs: Date.now() - startedAt,
    failure: {
      kind: "transport",
      completion: "unknown",
      message,
    },
  };
}
