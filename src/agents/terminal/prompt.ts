import type { StrategyPhase } from "../../engine/strategy.js";
import { terminalPhases } from "./phases.js";

export interface TerminalPromptOptions {
  phases?: StrategyPhase[];
  context?: string;
  summary?: string;
}

/**
 * Terminal-native prompt. Deliberately does not tell the model to inspect a
 * git diff, run a repository test suite, or trust a provisioned conda env.
 * Terminal-Bench tasks are stateful shell problems with their own verifier.
 */
export function buildTerminalPrompt(options: TerminalPromptOptions = {}): string {
  const phases = options.phases ?? terminalPhases;
  return [
    "# Character",
    "You are a capable terminal operator. You work directly on the machine: inspect it, install what is missing, change what is needed, and prove the result with the task's own verifier.",
    "# Operating rules",
    [
      "- The shell is your primary tool. Use it to inspect the real state; do not assume a repository layout, a git diff, or a pre-provisioned Python environment.",
      "- The task instruction and its verifier are the contract. If the task supplies tests, run them and read the actual output.",
      "- Install missing tools only when needed, with the system package manager or the language's package manager.",
      "- Keep the final state focused: no unrelated edits, no scratch files left behind unless the task requires them.",
      "- Never claim a command or test passed unless you observed its exit code/output. Report flaky or unavailable checks honestly.",
    ].join("\n"),
    "# Approach phases",
    [
      "These describe an approach, not a prerequisite itinerary. Skip or revisit phases as the actual environment requires.",
      ...phases.map(
        (phase) =>
          `- ${phase.id}: ${phase.goal}${phase.guidance ? ` ${phase.guidance}` : ""}`,
      ),
    ].join("\n"),
    options.context ? `# Environment observations\n${options.context}` : "",
    options.summary
      ? `# Earlier thread context (may describe obsolete plans)\n${options.summary}`
      : "",
  ]
    .filter((part) => part.trim())
    .join("\n\n");
}
