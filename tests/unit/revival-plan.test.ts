/**
 * Revival policy primitives — the pure decision (`planRevival`), cross-run
 * spend (`ThreadBudget`), and the publication-evidence rule
 * (`latestEvidenceForTree`). Lifted from the product; the rules are the
 * package's now, so every consumer asks them the same way.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AgentEvent } from "../../src/engine/events.js";
import { latestEvidenceForTree } from "../../src/engine/evidence.js";
import { planRevival, ThreadBudget } from "../../src/engine/revival.js";
import { LocalSandbox } from "../../src/sandbox/local.js";

const room = () =>
  new ThreadBudget({ maxTurns: 5, maxUsd: 10 }, { turnsUsed: 1, usdSpent: 1 });

describe("ThreadBudget", () => {
  it("accrues turns and dollars across runs and stops at either cap", () => {
    const budget = new ThreadBudget({ maxTurns: 3, maxUsd: 10 });
    expect(budget.exhausted).toBe(false);
    budget.record({ usd: 4 });
    budget.record({ usd: 4 });
    expect(budget.turnsUsed).toBe(2);
    expect(budget.usdLeft).toBe(2);
    budget.record({ usd: 2 });
    expect(budget.exhausted).toBe(true); // dollars hit the cap first

    const turns = new ThreadBudget(
      { maxTurns: 2, maxUsd: 100 },
      { turnsUsed: 2 },
    );
    expect(turns.exhausted).toBe(true);
    expect(turns.usdLeft).toBe(100);
  });
});

describe("planRevival", () => {
  it("revives with the same task, phase, and the agent's words", () => {
    const plan = planRevival({
      result: {
        reason: "budget_exceeded",
        phase: "validate",
        revival: {
          remaining: "finish the second half of the parser",
          estimatedSteps: 12,
        },
      },
      task: "Fix the issue",
      threadBudget: room(),
    });
    expect(plan).toEqual({
      action: "revive",
      task: "Fix the issue",
      startPhase: "validate",
      remaining: "finish the second half of the parser",
    });
  });

  it("accepts a checkpoint alone as handoff evidence", () => {
    const plan = planRevival({
      result: { reason: "max_steps", checkpointRef: "abc123" },
      task: "Fix the issue",
      threadBudget: room(),
    });
    expect(plan).toMatchObject({ action: "revive", remaining: "not stated" });
  });

  it("asks for a human once the thread's caps are spent", () => {
    const plan = planRevival({
      result: {
        reason: "budget_exceeded",
        revival: { remaining: "the last failing test" },
      },
      task: "Fix the issue",
      threadBudget: new ThreadBudget(
        { maxTurns: 2, maxUsd: 5 },
        { turnsUsed: 2, usdSpent: 5 },
      ),
    });
    expect(plan.action).toBe("needs_human");
    if (plan.action === "needs_human")
      expect(plan.note).toContain("the last failing test");
  });

  it("plans nothing without handoff evidence or a budget death", () => {
    expect(
      planRevival({
        result: { reason: "budget_exceeded" },
        task: "t",
        threadBudget: room(),
      }),
    ).toEqual({ action: "none" });
    expect(
      planRevival({
        result: { reason: "finished", revival: { remaining: "x" } },
        task: "t",
        threadBudget: room(),
      }),
    ).toEqual({ action: "none" });
  });
});

describe("latestEvidenceForTree", () => {
  const runEvent = (treeHash: string, ok: boolean): AgentEvent => ({
    type: "tool_result",
    phase: "validate",
    step: 1,
    name: "run_tests",
    ok,
    content: "tests",
    contentChars: 5,
    meta: { ran: true, treeHash },
  });

  it("vouches only for the exact tree, and fails closed when uninspectable", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anchor-evidence-"));
    const sandbox = new LocalSandbox({}, { rootDir, quiet: true });
    await sandbox.start();
    try {
      await sandbox.exec(`printf 'one\\n' > work.txt`);
      const hash = (
        await sandbox.exec("git add -A >/dev/null 2>&1 && git write-tree")
      ).stdout.trim();
      expect(hash).toMatch(/^[0-9a-f]{40}$/);

      const fresh = await latestEvidenceForTree(sandbox, [
        runEvent(hash, true),
      ]);
      expect(fresh).toEqual({
        inspected: true,
        treeHash: hash,
        verification: "passed",
      });

      const failed = await latestEvidenceForTree(sandbox, [
        runEvent(hash, false),
      ]);
      expect(failed).toMatchObject({ inspected: true, verification: "failed" });

      // The tree changed after the recorded run — green no longer counts.
      await sandbox.exec(`printf 'two\\n' > work.txt`);
      const stale = await latestEvidenceForTree(sandbox, [
        runEvent(hash, true),
      ]);
      expect(stale).toMatchObject({
        inspected: true,
        verification: "not_verified",
      });
      expect(stale.inspected && stale.treeHash).not.toBe(hash);

      // No executed run at all: not_verified, never "passed".
      const none = await latestEvidenceForTree(sandbox, []);
      expect(none).toMatchObject({
        inspected: true,
        verification: "not_verified",
      });
    } finally {
      await sandbox.destroy();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
