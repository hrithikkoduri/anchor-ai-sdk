/**
 * Budget guardrails: steps, tokens, dollars.
 *
 * The tracker is fed after every LLM call (`record`) and consulted at the top
 * of every turn (`exceeded`). Dollar checks are skipped when the provider
 * didn't report usage that maps to a price — the step and token caps still
 * bound the run.
 */
import type { LLMUsage } from "../llm/types.js";

export interface BudgetLimits {
  maxSteps: number;
  maxTokens: number;
  maxUsd: number;
  /**
   * Wall-clock ceiling in milliseconds. Absent = unbounded. Checked at turn
   * boundaries (the architecture's only safe cancel point), so a single tool
   * call may overrun it before the loop stops.
   */
  maxWallClockMs?: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxSteps: 40,
  maxTokens: 3_000_000,
  maxUsd: 5,
};

/**
 * Per-call cap on one model response — reasoning, text and tool calls
 * together. The per-run budgets below only notice an overspend *after* the
 * call returns, so a single degenerate generation can burn minutes and tens
 * of thousands of tokens before anything reacts. This bounds one call.
 *
 * 16k leaves ample room for normal work (typical turns here run ~1k) while
 * cutting off a runaway. A capped response ends with finishReason "length".
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

export interface BudgetExceeded {
  kind: "steps" | "tokens" | "usd" | "wallclock";
  detail: string;
}

export class BudgetTracker {
  readonly limits: BudgetLimits;
  promptTokens = 0;
  completionTokens = 0;
  reasoningTokens: number | undefined;
  cachedTokens = 0;
  costUsd = 0;
  costsKnown = true;
  /** Epoch ms the tracker started; wall-clock limits are measured from here. */
  readonly startedAtMs: number;

  constructor(limits: Partial<BudgetLimits> = {}, startedAtMs = Date.now()) {
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...limits };
    this.startedAtMs = startedAtMs;
  }

  record(usage: LLMUsage): void {
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    if (usage.reasoningTokens !== undefined) this.reasoningTokens = (this.reasoningTokens ?? 0) + usage.reasoningTokens;
    if (usage.cachedTokens !== undefined) this.cachedTokens += usage.cachedTokens;
    if (usage.costUsd !== undefined) {
      this.costUsd += usage.costUsd;
    } else {
      this.costsKnown = false;
    }
  }

  totalTokens(): number {
    return this.promptTokens + this.completionTokens;
  }

  /** Milliseconds elapsed since the tracker started. */
  wallClockMs(now = Date.now()): number {
    return now - this.startedAtMs;
  }

  /** Checked BEFORE each turn; `steps` is the count of turns already taken. */
  exceeded(steps: number): BudgetExceeded | null {
    if (steps >= this.limits.maxSteps) {
      return { kind: "steps", detail: `step budget exhausted (${steps}/${this.limits.maxSteps} turns)` };
    }
    if (this.totalTokens() >= this.limits.maxTokens) {
      return {
        kind: "tokens",
        detail: `token budget exhausted (${this.totalTokens()}/${this.limits.maxTokens} tokens)`,
      };
    }
    if (this.costsKnown && this.costUsd >= this.limits.maxUsd) {
      return { kind: "usd", detail: `dollar budget exhausted ($${this.costUsd.toFixed(4)}/$${this.limits.maxUsd})` };
    }
    const wallClock = this.limits.maxWallClockMs;
    if (wallClock !== undefined && wallClock > 0 && this.wallClockMs() >= wallClock) {
      const elapsed = Math.round(this.wallClockMs() / 1000);
      return {
        kind: "wallclock",
        detail: `wall-clock budget exhausted (${elapsed}s/${Math.round(wallClock / 1000)}s)`,
      };
    }
    return null;
  }

  /**
   * Fraction of the budget spent, 0..1 — the largest across every dimension
   * with a positive limit, so the tightest cap decides. `steps` is the count
   * of turns already taken. Used by the soft cap; never a stop on its own.
   */
  usedFraction(steps: number, now = Date.now()): number {
    const fractions: number[] = [];
    if (this.limits.maxSteps > 0) fractions.push(steps / this.limits.maxSteps);
    if (this.limits.maxTokens > 0)
      fractions.push(this.totalTokens() / this.limits.maxTokens);
    if (this.costsKnown && this.limits.maxUsd > 0)
      fractions.push(this.costUsd / this.limits.maxUsd);
    const wallClock = this.limits.maxWallClockMs;
    if (wallClock !== undefined && wallClock > 0)
      fractions.push(this.wallClockMs(now) / wallClock);
    return fractions.length > 0 ? Math.max(...fractions) : 0;
  }
}

/**
 * A delegated child's own budget. Any subset may be given; a missing
 * dimension falls back to the member's own limit and then to the derived
 * default (see `deriveChildBudget`).
 */
export interface ChildBudget {
  /** Turn ceiling for the child. */
  steps?: number;
  /** Wall-clock ceiling in ms for the child, checked at turn boundaries. */
  wallClockMs?: number;
  /** Dollar ceiling for the child. */
  usd?: number;
}

/** What the parent has left to give, as the derivation sees it. */
export interface BudgetRemaining {
  steps: number;
  /** Absent when the parent itself has no wall-clock ceiling. */
  wallClockMs?: number;
  usd: number;
}

/**
 * Where a child is told to wrap up: this fraction of its budget. It is a
 * nudge, not a stop — the child still gets to hand back a usable answer
 * before the hard cap at 1.0 ends the loop.
 */
export const DEFAULT_CHILD_SOFT_CAP = 0.8;

/** A child never derives more than this share of the parent's remaining budget. */
export const DEFAULT_CHILD_BUDGET_FRACTION = 0.5;

/**
 * Absolute ceilings on a DERIVED child budget. The point of the cap is
 * production: five workers on two vCPUs, one open-ended brief, 194 steps and
 * 48 minutes. An explicit budget (or a member limit) may still exceed these.
 */
export const DEFAULT_CHILD_BUDGET_CAP: Required<ChildBudget> = {
  steps: 60,
  wallClockMs: 12 * 60_000,
  usd: 1.5,
};

/**
 * The default per-child budget policy, as a pure function:
 *
 *   value = explicit, when given
 *         else min(fraction × parent's remaining, cap)
 *
 * An explicit `steps`/`wallClockMs`/`usd` always wins, so a consumer can hand
 * a worker more than the default. `steps` never derives below 1 — a child
 * gets at least one turn. `wallClockMs` still derives a cap when the parent
 * has no wall-clock ceiling of its own, because bounding an open-ended worker
 * is the whole point.
 */
export function deriveChildBudget(
  requested: ChildBudget | undefined,
  remaining: BudgetRemaining,
): Required<ChildBudget> {
  const fraction = DEFAULT_CHILD_BUDGET_FRACTION;
  const cap = DEFAULT_CHILD_BUDGET_CAP;
  const derivedSteps = Math.min(
    Math.floor(Math.max(0, remaining.steps) * fraction),
    cap.steps,
  );
  const derivedWallClock = Math.min(
    (remaining.wallClockMs ?? cap.wallClockMs) * fraction,
    cap.wallClockMs,
  );
  const derivedUsd = Math.min(Math.max(0, remaining.usd) * fraction, cap.usd);
  return {
    steps: requested?.steps ?? Math.max(1, derivedSteps),
    wallClockMs: requested?.wallClockMs ?? Math.max(1, Math.floor(derivedWallClock)),
    usd: requested?.usd ?? Math.max(0, derivedUsd),
  };
}
