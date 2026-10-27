/**
 * Supervision mechanics for long delegations: how long a cancelled run waits
 * for in-flight work, and how long a delegated child may go silent before the
 * supervisor is told.
 *
 * Policy (when a stall matters, what a nudge says) stays in the loop. This
 * module owns the two numbers and the one non-obvious await.
 */

/**
 * How long a cancelled run waits for the call already in flight before it
 * stops waiting and concludes `cancelled`. A stop is meant to cut the current
 * call quickly: a worker's own work survives (the host commits on cancel), so
 * a long grace only delays the answer. Overridable per run with
 * `EngineOptions.cancelGraceMs`; a host that passes its own value keeps it.
 */
export const DEFAULT_CANCEL_GRACE_MS = 5_000;

/**
 * How long a delegated child may produce no event before a `progress` event
 * with `stalled: true` is emitted. A stuck tool call is invisible otherwise:
 * `progress` is per-turn, and a hung tool is exactly the turn that never ends.
 * Overridable per run with `EngineOptions.stallAfterMs` (or `false` to disable).
 */
export const DEFAULT_STALL_AFTER_MS = 10 * 60_000;

/** Returned by `waitWithCancelGrace` when a cancelled run's grace expires. */
export const CANCEL_GRACE = Symbol("anchor.cancelGrace");

/**
 * Await `work`, but once `signal` is aborted give the call only `graceMs` to
 * finish before resolving to `CANCEL_GRACE`. The abandoned call keeps running
 * — the host force-kills the sandbox — and its eventual rejection is swallowed
 * so it can never surface after the run has ended. A rejection that arrives
 * BEFORE the abort still propagates.
 */
export function waitWithCancelGrace<T>(
  work: Promise<T>,
  signal: AbortSignal,
  graceMs: number,
): Promise<T | typeof CANCEL_GRACE> {
  if (signal.aborted) return Promise.resolve(CANCEL_GRACE);
  return new Promise<T | typeof CANCEL_GRACE>((resolve, reject) => {
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (graceTimer) clearTimeout(graceTimer);
    };
    const ok = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const giveUp = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(CANCEL_GRACE);
    };
    const onAbort = () => {
      graceTimer = setTimeout(giveUp, Math.max(0, graceMs));
      graceTimer.unref?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(ok, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}
