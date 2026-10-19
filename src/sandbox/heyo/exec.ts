/** Short control-plane requests around a guest-side job. Heyo's daemon may
 * impose a 30s exec ceiling regardless of the requested API timeout. Never
 * keep the HTTP request open for the duration of the user's command, and
 * never replay a launch when its result is ambiguous.
 *
 * Jobs are tracked per sandbox, not one-at-a-time: read-only commands may run
 * concurrently (`ExecRunOptions.concurrent`), while a mutation waits until no
 * earlier job's completion is unknown. A job whose guest-side deadline passes
 * without a receipt is killed and cleared — a lost receipt must fail the
 * command, never wedge every later command in the sandbox. */
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
  /** Detached on purpose — it must not gate later mutations. */
  backgrounded?: boolean;
}
const MARKER = "__ANCHOR_EXEC_STREAM__";

/** Per-call execution policy. */
export interface ExecRunOptions {
  /**
   * Safe to run alongside other in-flight jobs (read-only commands: reads,
   * searches). Mutations leave this unset and wait for an unclear earlier
   * job instead of overlapping it.
   */
  concurrent?: boolean;
  /**
   * Detach after this many seconds instead of waiting for completion. The job
   * keeps running; `poll`/`kill` address it later.
   */
  backgroundAfterSecs?: number;
}

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
    `if [ ! -d ${shq(dir)} ]; then printf 'GONE'; exit 0; fi; ` +
    `if [ -f ${shq(`${dir}/exit`)} ]; then ` +
    `printf 'DONE:'; cat ${shq(`${dir}/exit`)}; printf '\\n'; ` +
    ["stdout", "stderr", "output"]
      .map((file) => `base64 < ${shq(`${dir}/${file}`)}`)
      .join(`; printf '\\n${MARKER}\\n'; `) +
    `; else printf 'RUNNING'; fi`
  );
}

export class HeyoGuestExecutor {
  /** Jobs whose receipt has not arrived yet, keyed by guest directory. */
  private readonly jobs = new Map<string, Job>();
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
    if (reply.stdout.trim() === "GONE")
      throw new Error(`Guest job ${job.dir} is gone (receipt directory removed)`);
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

  /**
   * Kill an expired guest job and remove its receipt directory. The pattern
   * is expanded inside the guest (`u=<uuid>`), so this control command's own
   * command line never contains the literal job path it is matching — a bare
   * `pkill -f /tmp/anchor-exec-<uuid>` would otherwise match itself.
   */
  private async killDir(job: Job): Promise<boolean> {
    const id = job.dir.slice(job.dir.lastIndexOf("anchor-exec-") + 12);
    try {
      const reply = await this.control(
        `u=${shq(id)}; pkill -f "anchor-exec-$u" 2>/dev/null; rm -rf "/tmp/anchor-exec-$u"; printf killed`,
      );
      return reply.exit_code === 0;
    } catch {
      return false;
    }
  }

  /** A detached job still in flight — the sandbox must not be parked. */
  hasJobs(): boolean {
    return this.jobs.size > 0;
  }

  /**
   * Read a backgrounded job without needing the original in-memory registry:
   * an adopted sandbox has none, so the caller passes the launch facts. The
   * job directory is the identity (it is unique per launch inside the VM).
   */
  async poll(
    jobId: string,
    meta: { startedAt?: number; timeoutSecs?: number } = {},
  ): Promise<ExecResult | undefined> {
    const known = this.jobs.get(jobId);
    const started = known?.started ?? meta.startedAt ?? this.now();
    const timeoutSecs = known?.timeoutSecs ?? meta.timeoutSecs ?? 3600;
    const job: Job = known ?? {
      dir: jobId,
      started,
      timeoutSecs,
      deadline: started + (timeoutSecs + 25) * 1000,
    };
    const result = await this.observe(job);
    if (result) this.jobs.delete(jobId);
    return result;
  }

  /** Kill a backgrounded job (works from an adopted sandbox too). */
  async kill(jobId: string): Promise<boolean> {
    const known = this.jobs.get(jobId);
    const job: Job = known ?? {
      dir: jobId,
      started: this.now(),
      timeoutSecs: 0,
      deadline: this.now(),
    };
    const killed = await this.killDir(job);
    this.jobs.delete(jobId);
    return killed;
  }

  private backgrounded(job: Job, afterSecs: number): ExecResult {
    job.backgrounded = true;
    return {
      exitCode: -1,
      stdout: "",
      stderr: "",
      output: `Command still running after ${afterSecs}s; moved to the background (${job.dir}).`,
      timedOut: false,
      durationMs: this.now() - job.started,
      background: { jobId: job.dir },
    };
  }

  /**
   * A job past its guest-side deadline can only be dead: the supervisor's
   * `timeout -k` already fired. Kill whatever survived (a leaked child can
   * keep FIFOs open) and clear the slot so the sandbox is usable again.
   */
  private async reapExpired(now: number): Promise<void> {
    for (const job of [...this.jobs.values()]) {
      if (now < job.deadline) continue;
      if (await this.killDir(job)) this.jobs.delete(job.dir);
    }
  }

  async run(
    wrappedCommand: string,
    timeoutSecs: number,
    env?: Record<string, string>,
    opts: ExecRunOptions = {},
  ): Promise<ExecResult> {
    await this.reapExpired(this.now());

    // An unresolved earlier command may still be changing files. Observe it
    // before starting a mutation; don't turn a lost HTTP response into a
    // duplicate mutation or an overlapping command. Read-only callers opt out
    // of the gate — concurrent reads are safe and are the point of the
    // multiple-job registry.
    if (!opts.concurrent) {
      const [blocking] = [...this.jobs.values()].filter(
        (job) => !job.backgrounded,
      );
      if (blocking) {
        return this.unknown(
          blocking,
          `Previous command is still running (${blocking.dir}). No new command was launched. Do not retry a mutation blindly.`,
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
    this.jobs.set(job.dir, job);
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
          this.jobs.delete(job.dir);
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
    const detachAt =
      opts.backgroundAfterSecs && opts.backgroundAfterSecs > 0
        ? opts.backgroundAfterSecs * 1000
        : undefined;
    while (this.now() < job.deadline) {
      if (detachAt !== undefined && this.now() - job.started >= detachAt) {
        // Deliberately leave the job in the registry: it is still running and
        // its receipt directory is the handle. Mutations ignore it.
        return this.backgrounded(job, Math.round(detachAt / 1000));
      }
      try {
        const completed = await this.observe(job);
        if (completed) {
          this.jobs.delete(job.dir);
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
    // The guest supervisor writes `exit` by timeoutSecs + 10. No receipt by
    // timeoutSecs + 25 means it never will: fail the command, but clear the
    // slot so a single lost receipt cannot make every later command fail.
    const cleared = await this.killDir(job);
    if (cleared) this.jobs.delete(job.dir);
    return this.unknown(
      job,
      cleared
        ? `No completion receipt arrived for ${job.dir}; the guest job was killed and the exec slot cleared. Its final state is unknown (not confirmed completed).`
        : `No completion receipt arrived for ${job.dir}; it could not be killed, so the sandbox may still be busy. Its final state is unknown.`,
    );
  }
}
