/**
 * Daytona result/command plumbing — pure functions so the adapter's behavior
 * is testable without an account.
 *
 * The timeout rule is the repo-wide one: Daytona's `executeCommand` timeout is
 * a client/API deadline, and the documented guarantee is that the execution is
 * "terminated" when it elapses — but the repo has been burned before by a
 * control-plane timeout that did not stop the guest process. The command is
 * therefore still wrapped in coreutils `timeout -k` inside the sandbox,
 * exactly like the E2B and Docker backends, and exit 124/137 is reported as
 * `timedOut`.
 *
 * Daytona returns ONE combined output stream (`result`), not separate
 * stdout/stderr; `output` carries it verbatim and `stderr` stays empty rather
 * than fabricating a split the transport never made.
 */
import { shq, type ExecResult } from "../types.js";

/** The shape Daytona's `process.executeCommand` resolves with. */
export interface DaytonaCommandResult {
  exitCode?: number;
  result?: string;
}

/**
 * One self-contained command: switch to the workspace, then run the command
 * under a real kill deadline. Daytona runs the command through the first
 * available of zsh/bash/sh, so the extra `bash -c` exists to make `timeout`
 * the process-group owner.
 */
export function daytonaCommand(
  command: string,
  cwd: string,
  timeoutSecs: number,
): string {
  return `cd ${shq(cwd)} && timeout -k 5 ${timeoutSecs} bash -c ${shq(command)}`;
}

/** Map Daytona's result onto the SDK's ExecResult. */
export function daytonaResult(
  result: DaytonaCommandResult,
  startedAt: number,
): ExecResult {
  const exitCode =
    typeof result.exitCode === "number" ? result.exitCode : -1;
  const stdout = result.result ?? "";
  const timedOut = exitCode === 124 || exitCode === 137;
  return {
    exitCode,
    stdout,
    // One combined stream: no fabricated split. Callers that need to
    // distinguish read stderr from the combined `output` themselves.
    stderr: "",
    output: stdout,
    timedOut,
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
