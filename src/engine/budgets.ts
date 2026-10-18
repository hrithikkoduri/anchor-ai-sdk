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
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxSteps: 40,
  maxTokens: 1_500_000,
  maxUsd: 5,
};

export interface BudgetExceeded {
  kind: "steps" | "tokens" | "usd";
  detail: string;
}

export class BudgetTracker {
  readonly limits: BudgetLimits;
  promptTokens = 0;
  completionTokens = 0;
  reasoningTokens: number | undefined;
  costUsd = 0;
  costsKnown = true;

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...limits };
  }

  record(usage: LLMUsage): void {
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    if (usage.reasoningTokens !== undefined) this.reasoningTokens = (this.reasoningTokens ?? 0) + usage.reasoningTokens;
    if (usage.costUsd !== undefined) {
      this.costUsd += usage.costUsd;
    } else {
      this.costsKnown = false;
    }
  }

  totalTokens(): number {
    return this.promptTokens + this.completionTokens;
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
    return null;
  }
}
