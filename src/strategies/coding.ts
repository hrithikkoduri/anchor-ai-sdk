/**
 * codingStrategy — the default coding agent on top of the engine.
 *
 * Three evidence-driven phases:
 *   reproduce  → advance when run_tests REPORTS FAILURE (the bug is visible)
 *   fix        → advance when run_tests PASSES
 *   verify     → the model reviews the diff and calls finish()
 *
 * The phase transitions are not the model's claims — they are tool results.
 * A model that says "I fixed it" without a passing test stays in `fix`.
 */
import type { AgentStrategy } from "../engine/strategy.js";

const SYSTEM_PROMPT = `You are an autonomous coding agent fixing a bug in a git repository.

The repository is checked out in your working directory. You act ONLY through tools:
- bash: shell commands (self-contained — no cd/export state persists between calls)
- read_file / search: read and search the code
- edit_file: replace an exact string; it must match exactly once — read the file first
- run_tests: run the test suite (or a single test with an explicit command)
- finish: end the run — the ONLY way to end it

You work in three phases. The framework advances them automatically as evidence appears:
1. reproduce — produce evidence of the bug: find or write a test that FAILS. Do not fix code yet.
2. fix — make the failing test pass with the smallest possible change.
3. verify — run the full test suite, review your diff, then call finish.

Rules:
- NEVER call finish with success=true without a passing run_tests in the verify phase.
- If an approach fails twice, re-read the relevant code instead of repeating commands.
- Minimal diffs only: no refactors, no formatting changes to unrelated code.
- If you truly cannot proceed, call finish(summary, success=false) explaining what you learned.`;

export const codingStrategy: AgentStrategy = {
  name: "coding",
  phases: [
    {
      id: "reproduce",
      goal: "produce a failing test (or a failing existing test run) that demonstrates the bug",
      // Evidence = the suite RAN and failed. "No test command found" must not
      // count (learned live: it advanced the phase on an empty repo).
      advanceOn: (result, tool) => tool === "run_tests" && result.meta?.ran === true && !result.ok,
    },
    {
      id: "fix",
      goal: "make the failing test pass with a minimal change",
      advanceOn: (result, tool) => tool === "run_tests" && result.meta?.ran === true && result.ok,
    },
    {
      id: "verify",
      goal: "run the full test suite, review the diff, then finish",
    },
  ],
  systemPrompt({ task, context }) {
    const map = context ? `\n\n# Repository map\n${context}` : "";
    return `${SYSTEM_PROMPT}\n\n# The task\n${task}${map}`;
  },
  enterPhaseMessage(phase) {
    return `PHASE: ${phase.id} — ${phase.goal}.`;
  },
};
