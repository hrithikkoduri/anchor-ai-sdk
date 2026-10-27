/**
 * Budget revival — the engine's half: a small prompt block, the near-limit
 * warning, the numbers the warning carries, and the pure decision the
 * consumer drives (`planRevival` + `ThreadBudget`). The `request_revival`
 * tool itself lives in the loop (an intrinsic, like finish/set_phase).
 * Whether a request is ever funded is the consumer's decision:
 * `EngineOptions.revival` only turns the mechanism on.
 */
import type { AgentResult } from "./types.js";

export const DEFAULT_WARN_AT_PERCENT = 85;

/** Clamp the warning threshold into a sane percent (default 85, max 99). */
export function warnPercent(warnAtPercent?: number): number {
  const percent = warnAtPercent ?? DEFAULT_WARN_AT_PERCENT;
  if (!Number.isFinite(percent) || percent <= 0) return DEFAULT_WARN_AT_PERCENT;
  return Math.min(percent, 99);
}

/** The system-prompt block that explains the deal to the model. */
export function revivalBlock(warnAtPercent: number): string {
  return [
    "## Budget and revival",
    `This run has a limited budget (steps, tokens, dollars). You will be warned near ${warnAtPercent}%.`,
    "If you cannot finish before it runs out, call request_revival stating what remains and your honest estimate of the next run's needs — steps and tokens, with your own buffer included.",
    "No request means the work may simply stop. A funded run that also runs out needs a human, so estimate carefully: neither optimistic nor padded.",
  ].join("\n");
}

/** The runtime-only user message injected once at the warning line. */
export function budgetWarning(usage: {
  tokensUsed: number;
  tokenLimit: number;
  stepsUsed: number;
  stepLimit: number;
  usdUsed?: number;
  usdLimit?: number;
}): string {
  const parts = [
    `${usage.tokensUsed}/${usage.tokenLimit} tokens`,
    `${usage.stepsUsed}/${usage.stepLimit} steps`,
  ];
  if (usage.usdUsed !== undefined && usage.usdLimit !== undefined)
    parts.push(`$${usage.usdUsed.toFixed(2)}/$${usage.usdLimit}`);
  return (
    `Budget warning: the run budget is nearly spent (${parts.join(", ")}). ` +
    "If you cannot finish, call request_revival now — what remains, and your estimate of the next run's steps and tokens (include your own buffer). " +
    "Otherwise, spend what is left on the most valuable remaining step and wrap up cleanly."
  );
}

/**
 * Cross-run spend against a thread's own caps — the revival chain's stop
 * condition. A thread, not a run: revival exists because runs end and the
 * work does not, so the budget that binds is measured across all of them.
 */
export class ThreadBudget {
  turnsUsed: number;
  usdSpent: number;

  constructor(
    readonly limits: { maxTurns: number; maxUsd: number },
    spend: { turnsUsed?: number; usdSpent?: number } = {},
  ) {
    this.turnsUsed = spend.turnsUsed ?? 0;
    this.usdSpent = spend.usdSpent ?? 0;
  }

  /** Record one run: a turn taken, and the dollars it is known to have cost. */
  record(run: { usd?: number } = {}): void {
    this.turnsUsed += 1;
    this.usdSpent += run.usd ?? 0;
  }

  get turnsLeft(): number {
    return Math.max(0, this.limits.maxTurns - this.turnsUsed);
  }

  get usdLeft(): number {
    return Math.max(0, this.limits.maxUsd - this.usdSpent);
  }

  /** At either cap, no revival is offered — a human decides what happens next. */
  get exhausted(): boolean {
    return (
      this.turnsUsed >= this.limits.maxTurns ||
      this.usdSpent >= this.limits.maxUsd
    );
  }
}

export type RevivalPlan =
  | {
      /** Queue another run: same task, same phase, same budget as the dead one. */
      action: "revive";
      task: string;
      startPhase?: string;
      /** The agent's own words about what remains. */
      remaining: string;
    }
  /** The thread's caps are spent — a note for a human instead of another run. */
  | { action: "needs_human"; note: string }
  /** No handoff evidence, or the run did not die of budget — nothing to plan. */
  | { action: "none" };

/**
 * The pure revival decision. The death is the cue: a run that ended out of
 * budget with a handoff (a request and/or a checkpoint) continues as a fresh
 * run with the SAME task, phase, and budget — until the thread's own caps are
 * spent. Nothing here touches a database; callers keep idempotence (their own
 * `revived` flag) and the queueing on their side.
 */
export function planRevival(args: {
  result: Pick<AgentResult, "reason" | "revival" | "checkpointRef" | "phase">;
  /** The task to carry forward verbatim through the revival chain. */
  task: string;
  threadBudget: ThreadBudget;
}): RevivalPlan {
  const diedOfBudget =
    args.result.reason === "budget_exceeded" ||
    args.result.reason === "max_steps" ||
    args.result.reason === "budget_exhausted";
  const handoff = args.result.revival ?? args.result.checkpointRef;
  if (!diedOfBudget || !handoff) return { action: "none" };

  if (args.threadBudget.exhausted) {
    return {
      action: "needs_human",
      note:
        "The thread's budget is spent, so this run was not revived — a human needs to raise the budget or narrow the task. Still remaining (per the agent): " +
        remainingText(args.result.revival),
    };
  }
  return {
    action: "revive",
    task: args.task,
    ...(args.result.phase ? { startPhase: args.result.phase } : {}),
    remaining: remainingText(args.result.revival),
  };
}

/** The agent's own words about what remains, for the needs-human note. */
function remainingText(revival: AgentResult["revival"]): string {
  const remaining = revival?.remaining;
  return typeof remaining === "string" && remaining.trim()
    ? remaining.trim()
    : "not stated";
}
