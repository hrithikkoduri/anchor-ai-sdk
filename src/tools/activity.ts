import type { Tool } from "./types.js";

/** Stable default activity verbs; consumers may supply a verb on a custom tool. */
export function toolVerb(name: string, input: Record<string, unknown>, custom?: Tool["verb"]): string {
  try {
    const configured = typeof custom === "function" ? custom(input) : custom;
    if (configured?.trim()) return configured.trim().slice(0, 160);
  } catch { /* display metadata must never break tool execution */ }
  const path = typeof input.path === "string" ? ` ${input.path.slice(0, 120)}` : "";
  switch (name) {
    case "read_file": return `Reading${path || " a file"}`;
    case "edit_file": return `Updating${path || " a file"}`;
    case "search": return "Searching the repository";
    case "bash": return "Running a command";
    case "run_tests": return "Running tests";
    case "advance": return "Moving to the next phase";
    case "finish": return "Wrapping up";
    default: return `Calling ${name.replace(/_/g, " ")}`;
  }
}
