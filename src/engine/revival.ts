/**
 * Budget revival — the engine's half: a small prompt block, the near-limit
 * warning, and the numbers the warning carries. The `request_revival` tool
 * itself lives in the loop (an intrinsic, like finish/set_phase). Whether a
 * request is ever funded is the consumer's decision: `EngineOptions.revival`
 * only turns the mechanism on.
 */

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
