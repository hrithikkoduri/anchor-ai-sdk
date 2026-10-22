import type { StrategyPhase } from "../../engine/strategy.js";

/** Terminal work: inspect the machine, act, prove, report. No repo assumption. */
export const terminalPhases: StrategyPhase[] = [
  {
    id: "inspect",
    goal: "Establish the machine state, task artifacts, and available tooling.",
    guidance:
      "Use the shell. Check the working directory, installed runtimes, task files, and any verifier/tests. Do not assume a git repository, /testbed, or a project test command.",
  },
  {
    id: "plan",
    goal: "Choose the shortest reliable path to the task's own success condition.",
    guidance:
      "Name the concrete commands, installs, edits, and checks. Prefer the task's own verifier over generic repo tests.",
  },
  {
    id: "act",
    goal: "Execute the task with terminal-native steps.",
    guidance:
      "Run commands, install missing tools, modify files, and adjust when output changes the picture. Keep the workspace clean of scratch artifacts.",
  },
  {
    id: "verify",
    goal: "Run the task's verifier and inspect its actual output.",
    guidance:
      "The task's test/verifier is the source of truth. Re-run after the final change. Report missing or flaky checks honestly.",
  },
  {
    id: "respond",
    goal: "Deliver the outcome with the commands and evidence that prove it.",
    guidance:
      "State what changed and what was actually verified. Do not claim a pass you did not observe.",
  },
];
