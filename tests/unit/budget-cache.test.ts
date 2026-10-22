import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../../src/engine/budgets.js";

describe("BudgetTracker", () => {
  it("accumulates prompt-cache reads instead of dropping them", () => {
    const budget = new BudgetTracker();
    budget.record({
      promptTokens: 1000,
      completionTokens: 10,
      totalTokens: 1010,
      cachedTokens: 800,
      costUsd: 0.001,
    });
    budget.record({
      promptTokens: 500,
      completionTokens: 5,
      totalTokens: 505,
      cachedTokens: 400,
    });

    expect(budget.promptTokens).toBe(1500);
    expect(budget.cachedTokens).toBe(1200);
    expect(budget.costsKnown).toBe(false);
  });
});
