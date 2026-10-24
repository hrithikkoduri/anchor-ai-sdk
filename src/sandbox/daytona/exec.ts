/**
 * Daytona result/command plumbing — pure functions so the adapter's behavior
 * is testable without a live account.
 *
 * The timeout rule is the repo-wide one: Daytona's per-call `timeout` is a
 * request deadline, not proof that the guest process died. Every command is
 * wrapped in coreutils `timeout -k` inside the sandbox, and exit 124/137 is
 * reported as `timedOut`.
 *
 * The toolbox executes a session command with no `cwd`/`env` parameters, so
 * the wrapper carries both: `cd <cwd> && env K=V … timeout -k 5 N bash -c …`.
 * `env` is a real binary here (not a shell builtin) so values keep their
 * quoting and never pass through a second shell parse.
 */
import { shq, type ExecResult } from "../types.js";

/** The shape a synchronous `executeSessionCommand` returns. */
export interface DaytonaCommandResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  output?: string;
  error?: string;
}

/** One self-contained command with a workspace, env, and a kill deadline. */
export function daytonaCommand(
  command: string,
  cwd: string,
  timeoutSecs: number,
  env: Record<string, string> = {},
): string {
  const assignments = Object.entries(env).map(
    ([key, value]) => `${key}=${value}`,
  );
  const envPrefix = assignments.length
    ? `env ${assignments.map(shq).join(" ")} `
    : "";
  return (
    `cd ${shq(cwd)} && ${envPrefix}` +
    `timeout -k 5 ${timeoutSecs} bash -c ${shq(command)}`
  );
}

/** Map a Daytona session result onto the SDK's ExecResult. */
export function daytonaResult(
  result: DaytonaCommandResult,
  startedAt: number,
): ExecResult {
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : -1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = result.output ?? `${stdout}${stderr}`;
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
