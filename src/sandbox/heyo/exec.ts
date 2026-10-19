/** Short control-plane requests around a guest-side job. Heyo's daemon may
 * impose a 30s exec ceiling regardless of the requested API timeout. Never
 * keep the HTTP request open for the duration of the user's command, and
 * never replay a launch when its result is ambiguous. */
import { randomUUID } from "node:crypto";
import { shq, type ExecResult } from "../types.js";

interface Reply {
  exit_code: number;
  stdout: string;
  stderr: string;
  output: string;
}
export type GuestControl = (
  command: string,
  env?: Record<string, string>,
) => Promise<Reply>;
interface Job {
  dir: string;
  deadline: number;
  started: number;
  timeoutSecs: number;
}
const MARKER = "__ANCHOR_EXEC_STREAM__";

export function buildJobLaunch(
  dir: string,
  wrappedCommand: string,
  timeoutSecs: number,
): string {
  const worker = [
    // Named pipes avoid GNU Bash retaining hidden process-substitution FDs
    // (62/63) across exec redirects, which can deadlock wait on Linux.
    `mkfifo ${shq(`${dir}/stdout.pipe`)} ${shq(`${dir}/stderr.pipe`)}`,
    `tee ${shq(`${dir}/stdout`)} < ${shq(`${dir}/stdout.pipe`)} >> ${shq(`${dir}/output`)} &`,
    `out_pid=$!`,
    `tee ${shq(`${dir}/stderr`)} < ${shq(`${dir}/stderr.pipe`)} >> ${shq(`${dir}/output`)} &`,
    `err_pid=$!`,
    `${wrappedCommand} > ${shq(`${dir}/stdout.pipe`)} 2> ${shq(`${dir}/stderr.pipe`)}`,
    `rc=$?`,
    `wait "$out_pid"; out_rc=$?`,
    `wait "$err_pid"; err_rc=$?`,
    `if [ "$rc" -eq 0 ] && { [ "$out_rc" -ne 0 ] || [ "$err_rc" -ne 0 ]; }; then rc=125; fi`,
    `exit "$rc"`,
  ].join("\n");
  // Supervise collectors as well as the command: background descendants must
  // not hold a FIFO open forever after their parent shell returns. GNU timeout
  // owns this process group; the outer receipt writer survives its termination.
  const supervisor = [
    `timeout -k 5 ${timeoutSecs + 10} bash -c ${shq(worker)}`,
    `rc=$?`,
    `printf '%s' "$rc" > ${shq(`${dir}/exit.tmp`)}`,
    `mv ${shq(`${dir}/exit.tmp`)} ${shq(`${dir}/exit`)}`,
  ].join("\n");
  return `umask 077; mkdir -p ${shq(dir)} && { nohup bash -c ${shq(supervisor)} </dev/null >/dev/null 2>&1 & }`;
}

export function buildJobObservation(dir: string): string {
  return (
    `if [ -f ${shq(`${dir}/exit`)} ]; then ` +
    `printf 'DONE:'; cat ${shq(`${dir}/exit`)}; printf '\\n'; ` +
    ["stdout", "stderr", "output"]
      .map((file) => `base64 < ${shq(`${dir}/${file}`)}`)
      .join(`; printf '\\n${MARKER}\\n'; `) +
    `; else printf 'RUNNING'; fi`
  );
}

export class HeyoGuestExecutor {
  private pending: Job | undefined;
  constructor(
    private readonly control: GuestControl,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now = Date.now,
  ) {}

  private unknown(job: Job, message: string): ExecResult {
    return {
      exitCode: -1,
      stdout: "",
      stderr: message,
      output: message,
      timedOut: false,
      durationMs: this.now() - job.started,
      failure: {
        kind: "transport",
        completion: "unknown",
        jobId: job.dir,
        message,
      },
    };
  }

  private async observe(job: Job): Promise<ExecResult | undefined> {
    const reply = await this.control(buildJobObservation(job.dir));
    if (reply.exit_code !== 0)
      throw new Error(reply.output || "Could not read the guest job receipt");
    if (reply.stdout.trim() === "RUNNING") return undefined;
    const match = /^DONE:(-?\d+)\r?\n([\s\S]*)$/.exec(reply.stdout);
    if (!match) throw new Error("Invalid guest job completion receipt");
    const streams = match[2]!.split(`\n${MARKER}\n`);
    if (streams.length !== 3)
      throw new Error("Incomplete guest job output receipt");
    const [stdout, stderr, output] = streams.map((stream) =>
      Buffer.from(stream.replace(/\s/g, ""), "base64").toString("utf8"),
    );
    const exitCode = Number(match[1]);
    const durationMs = this.now() - job.started;
    return {
      exitCode,
      stdout: stdout!,
      stderr: stderr!,
      output: output!,
      timedOut:
        exitCode === 124 ||
        (exitCode === 137 && durationMs >= job.timeoutSecs * 1000),
      durationMs,
    };
  }

  async run(
    wrappedCommand: string,
    timeoutSecs: number,
    env?: Record<string, string>,
  ): Promise<ExecResult> {
    // An unconfirmed earlier command may still be changing files. Observe it
    // before starting anything else; don't turn a lost HTTP response into a
    // duplicate mutation or an overlapping command.
    if (this.pending) {
      try {
        if (!(await this.observe(this.pending)))
          return this.unknown(
            this.pending,
            `Previous command is still running (${this.pending.dir}). No new command was launched. Do not retry a mutation blindly.`,
          );
        this.pending = undefined;
      } catch (err) {
        return this.unknown(
          this.pending!,
          `Previous command completion is unknown. No new command was launched: ${String(err)}`,
        );
      }
    }
    const started = this.now();
    const job: Job = {
      dir: `/tmp/anchor-exec-${randomUUID()}`,
      started,
      deadline: started + (timeoutSecs + 25) * 1000,
      timeoutSecs,
    };
    this.pending = job;
    try {
      const launch = await this.control(
        buildJobLaunch(job.dir, wrappedCommand, timeoutSecs),
        env,
      );
      if (launch.exit_code !== 0)
        throw new Error(launch.output || "Guest job launch failed");
    } catch (err) {
      // The launch might have reached the VM even if its HTTP response didn't.
      // Only poll for its receipt; never submit the launch a second time.
      try {
        const completed = await this.observe(job);
        if (completed) {
          this.pending = undefined;
          return completed;
        }
      } catch {
        /* preserve the original launch failure */
      }
      return this.unknown(
        job,
        `Execution request failed; command completion is unknown (${job.dir}): ${String(err)}`,
      );
    }
    let readFailures = 0;
    while (this.now() < job.deadline) {
      try {
        const completed = await this.observe(job);
        if (completed) {
          this.pending = undefined;
          return completed;
        }
        readFailures = 0;
      } catch (err) {
        if (++readFailures >= 3)
          return this.unknown(
            job,
            `Could not confirm command completion (${job.dir}). The guest-side deadline remains in force: ${String(err)}`,
          );
      }
      await this.wait(500);
    }
    return this.unknown(
      job,
      `No completion receipt arrived for ${job.dir}. The command's final state is unknown; no automatic replay was attempted.`,
    );
  }
}
