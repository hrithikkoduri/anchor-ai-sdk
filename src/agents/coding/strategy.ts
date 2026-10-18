/**
 * codingStrategy — the default coding agent on top of the engine.
 *
 * Three phases; the agent drives every move and each move is checked
 * (decision #35):
 *   reproduce → advance() once a test run REPORTS FAILURE (checked)
 *   fix       → advance() once the full suite PASSES (checked)
 *   verify    → the model reviews the diff and calls finish()
 *
 * A move is never the model's claim alone — the check sees the tool results.
 * A model that says "I fixed it" without a passing test stays in `fix`.
 */
import type { AgentStrategy, ToolResultRecord } from "../../engine/strategy.js";
import { buildRepoMap } from "./repomap.js";

const SYSTEM_PROMPT = `You are an autonomous coding agent fixing a bug in a git repository.

The repository is checked out in your working directory. You act ONLY through tools:
- bash: shell commands (self-contained — no cd/export state persists between calls)
- read_file / search: read and search the code
- edit_file: replace an exact string; it must match exactly once — read the file first
- run_tests: run the test suite (or a single test with an explicit command)
- advance: move on when the current phase's work is done (the phase checks the move)
- finish: end the run — the ONLY way to end it

You work in three phases. You decide when to move on; the checks decide whether it is allowed:
1. reproduce — produce evidence of the bug: find or write a test that FAILS. Do not fix code yet.
   Once a run reports a failure, call advance() to move to fix.
2. fix — make the failing test pass with the smallest possible change. Once the FULL suite is
   green, call advance() to move to verify (checked: a green full-suite run must be on record).
3. verify — run the full test suite, review your diff, then call finish.

Rules:
- NEVER call finish with success=true without a passing run_tests in the verify phase.
- If an approach fails twice, re-read the relevant code instead of repeating commands.
- Minimal diffs only: no refactors, no formatting changes to unrelated code.
- If you truly cannot proceed, call finish(summary, success=false) explaining what you learned.
- If a phase's check cannot be satisfied but you are confident moving on is right, call
  advance({force: true}) — the override is recorded, and finish(success=true) is still checked.
- When the work is done but a follow-up should be driven by external signals (CI results,
  review comments), conclude with disposition="watch", watch={"checks":true,"comments":true},
  and resumeAt set to the phase a future run should start at (usually "fix"). Use
  disposition="blocked" when you need a human.`;

/** The repo's canonical (default-command) suite run, most recent first. */
const lastFullRun = (evidence: ToolResultRecord[]) =>
  [...evidence]
    .reverse()
    .find((r) => r.tool === "run_tests" && r.meta?.ran === true && r.meta?.defaultCommand === true);

export const codingStrategy: AgentStrategy = {
  name: "coding",
  // Capabilities only — finish/advance are engine intrinsics, injected automatically.
  requiredTools: ["bash", "read_file", "edit_file", "search", "run_tests"],
  requiresSandbox: true,
  phases: [
    {
      id: "reproduce",
      goal: "produce a failing test (or a failing existing test run) that demonstrates the bug",
      // Soft deadline: reproduction can be genuinely impossible.
      maxSteps: 12,
      // Check on the move out (decision #35): the agent decides WHEN, the
      // check decides WHETHER. Any source counts — the agent may write a NEW
      // test and run it explicitly. "No test command found" does not count
      // (learned live: it advanced on an empty repo).
      validateAdvance({ to, evidence }) {
        if (to !== "fix") {
          return { allow: false, reason: `from reproduce the agent advances to "fix" — not "${to}"` };
        }
        const failing = evidence.some((r) => r.tool === "run_tests" && r.meta?.ran === true && !r.ok);
        return failing
          ? { allow: true, reason: "a failing test run is on record" }
          : { allow: false, reason: "no failing test run on record — reproduce the bug first" };
      },
    },
    {
      id: "fix",
      goal: "make the failing test pass with a minimal change",
      maxSteps: 20,
      validateAdvance({ to, evidence }) {
        if (to !== "verify") {
          return { allow: false, reason: `from fix the agent advances to "verify" — not "${to}"` };
        }
        const lastFull = lastFullRun(evidence);
        if (!lastFull) {
          return { allow: false, reason: "no full test-suite run is on record — run the default test command first" };
        }
        if (!lastFull.ok) {
          return { allow: false, reason: "the most recent full test-suite run failed — fix it first" };
        }
        return { allow: true, reason: "full suite is green" };
      },
    },
    {
      id: "verify",
      goal: "run the full test suite, review the diff, then finish",
      maxSteps: 8,
      validateAdvance({ to, evidence }) {
        // Backward moves are a feature: verify found the fix wrong → fix again.
        if (to !== "fix") {
          return { allow: false, reason: `from verify the agent moves back to "fix" or calls finish` };
        }
        const lastFail = [...evidence]
          .reverse()
          .find((r) => r.tool === "run_tests" && r.meta?.ran === true && !r.ok);
        return lastFail
          ? { allow: true, reason: "a failing run is on record — back to fixing" }
          : { allow: false, reason: "no failing test on record — there is nothing to go back to" };
      },
    },
  ],
  validateFinish(evidence) {
    const lastFull = lastFullRun(evidence);
    if (!lastFull) {
      return { allow: false, reason: "no full test-suite run is on record — run the default test command first" };
    }
    if (!lastFull.ok) {
      return { allow: false, reason: "the most recent full test-suite run failed" };
    }
    return { allow: true };
  },
  prepareContext(sandbox) {
    if (!sandbox) throw new Error("codingStrategy requires a sandbox");
    return buildRepoMap(sandbox);
  },
  systemPrompt({ task, context, summary }) {
    const map = context ? `\n\n# Repository map\n${context}` : "";
    const prior = summary ? `\n\n# Summary of earlier work on this session\n${summary}` : "";
    return `${SYSTEM_PROMPT}${prior}\n\n# The task\n${task}${map}`;
  },
  enterPhaseMessage(phase) {
    return `PHASE: ${phase.id} — ${phase.goal}.`;
  },
};
