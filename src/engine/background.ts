/**
 * Background-job delivery — the engine's half.
 *
 * A provider with `pollJob` lets `bash` detach a long command: the tool returns
 * immediately with a job id. From there the engine owns the result: it polls
 * outstanding jobs at every turn boundary, injects a finished one as a
 * runtime-only message (never persisted, never shown to the user), and — when
 * the run is about to end — waits for what is left instead of dropping it.
 *
 * Nothing here is provider-specific: `pollJob` returning `undefined` means
 * "still running", and a throw means the receipt is gone.
 */
import type { ExecResult, Sandbox } from "../sandbox/types.js";
import { formatExec } from "../tools/types.js";
import { spillOrTruncate } from "../tools/truncate.js";
import type { BackgroundJob } from "./types.js";

/** How long to sleep between polls while waiting for a run-ending job. */
export const BACKGROUND_POLL_MS = 500;
/** Grace past the job's own deadline before we call the receipt lost. */
const DEADLINE_GRACE_MS = 30_000;

export interface FinishedJob {
  job: BackgroundJob;
  result: ExecResult;
}

export interface LostJob {
  job: BackgroundJob;
  error: string;
}

export interface PollOutcome {
  finished: FinishedJob[];
  running: BackgroundJob[];
  lost: LostJob[];
}

/** One non-blocking round over every outstanding job. */
export async function pollBackgroundJobs(
  sandbox: Sandbox | undefined,
  jobs: BackgroundJob[],
): Promise<PollOutcome> {
  if (!sandbox?.pollJob || jobs.length === 0) {
    return { finished: [], running: [...jobs], lost: [] };
  }
  const finished: FinishedJob[] = [];
  const running: BackgroundJob[] = [];
  const lost: LostJob[] = [];
  for (const job of jobs) {
    try {
      const result = await sandbox.pollJob(job.jobId, {
        startedAt: job.startedAt,
        ...(job.timeoutSecs !== undefined
          ? { timeoutSecs: job.timeoutSecs }
          : {}),
      });
      if (result) finished.push({ job, result });
      else running.push(job);
    } catch (err) {
      lost.push({
        job,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { finished, running, lost };
}

/**
 * Wait for the outstanding jobs, bounded by each job's own deadline + grace.
 * Used only when a run is about to finish normally: ending the run while a
 * job is still out there would silently lose its result.
 */
export async function waitForBackgroundJobs(
  sandbox: Sandbox | undefined,
  jobs: BackgroundJob[],
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PollOutcome> {
  // Without a poller there is nothing to wait on; end the run and report the
  // jobs instead of sleeping until a deadline that can never be observed.
  if (!sandbox?.pollJob || jobs.length === 0) {
    return { finished: [], running: [...jobs], lost: [] };
  }
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const finished: FinishedJob[] = [];
  const lost: LostJob[] = [];
  let remaining = [...jobs];

  while (remaining.length > 0) {
    if (opts.signal?.aborted) break;
    const outcome = await pollBackgroundJobs(sandbox, remaining);
    finished.push(...outcome.finished);
    lost.push(...outcome.lost);
    remaining = outcome.running;
    if (remaining.length === 0) break;

    const now = Date.now();
    const expired = remaining.filter(
      (job) =>
        now >
        job.startedAt + ((job.timeoutSecs ?? 3600) + 30) * 1000 +
          DEADLINE_GRACE_MS,
    );
    for (const job of expired) {
      lost.push({
        job,
        error: "no result before the job's deadline",
      });
    }
    if (expired.length > 0) {
      remaining = remaining.filter((job) => !expired.includes(job));
      if (remaining.length === 0) break;
    }
    await sleep(BACKGROUND_POLL_MS);
  }
  return { finished, running: remaining, lost };
}

/**
 * The runtime message the model sees. The body goes through the SAME
 * truncate-and-spill path as a normal tool result, so a long test log is
 * bounded and the full text stays addressable in scratch.
 */
export async function renderBackgroundResult(
  job: FinishedJob,
  sandbox: Sandbox | undefined,
): Promise<string> {
  const { result } = job;
  const label = job.job.command ? ` (${job.job.command})` : "";
  const status = result.timedOut
    ? `timed out (exit ${result.exitCode})`
    : `exit ${result.exitCode}`;
  const body = await spillOrTruncate(
    formatExec(result, job.job.timeoutSecs ?? 120),
    { sandbox, label: `background ${job.job.tool}` },
  );
  return `[runtime] Background job ${job.job.jobId}${label} finished: ${status}.\n${body}`;
}

export function renderLostJob(job: LostJob): string {
  return (
    `[runtime] Background job ${job.job.jobId} is no longer readable: ${job.error}. ` +
    `Do not assume it completed; check the workspace or rerun it if the result matters.`
  );
}