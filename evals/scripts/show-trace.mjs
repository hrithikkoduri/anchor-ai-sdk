#!/usr/bin/env node
/**
 * Read an agent execution, human-first.
 *
 *   node scripts/show-trace.mjs .eval-runs/<run>/traces/<task>.jsonl
 *
 * JSONL of engine events written live by the runner. Truncates long text by
 * default; `--full` shows everything.
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const full = argv.includes("--full");
const files = argv.filter((arg) => !arg.startsWith("--"));
if (files.length === 0) {
  console.error("usage: show-trace.mjs <trace.jsonl|trajectory.json> [--full]");
  process.exit(1);
}

const cut = (text, limit) => {
  const value = String(text ?? "");
  if (full || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n    … (+${value.length - limit} chars)`;
};
const indent = (text, pad) =>
  String(text ?? "")
    .split("\n")
    .join(`\n${pad}`);

function showAnchor(path) {
  const events = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  for (const event of events) {
    switch (event.type) {
      case "run_started": {
        const firstLines = String(event.task ?? "")
          .split("\n")
          .slice(0, 4);
        console.log(`══ ${path}`);
        console.log(`   task: ${firstLines.join(" / ")}`);
        console.log(`   phases: ${(event.phases ?? []).join(" → ")}\n`);
        break;
      }
      case "phase_started":
        console.log(`\n── phase: ${event.phase} ─────────────────────`);
        break;
      case "llm_call_finished": {
        console.log(`\n[step ${event.step} · ${event.phase}]`);
        if (event.reasoning) {
          console.log(`  💭 ${indent(cut(event.reasoning, 800), "     ")}`);
        }
        if (event.text) {
          console.log(`  🗨  ${indent(cut(event.text, 1200), "     ")}`);
        }
        break;
      }
      case "tool_call":
        console.log(`  → ${event.verb ?? event.name}`);
        console.log(
          `    ${indent(cut(JSON.stringify(event.input), 300), "    ")}`,
        );
        break;
      case "tool_result":
        console.log(
          `    ${event.ok ? "✓" : "✗"} ${indent(cut(event.content, 600), "      ")}`,
        );
        break;
      case "materialization_nudge":
        console.log(`  (nudge: ${cut(JSON.stringify(event), 200)})`);
        break;
      case "checkpoint":
        console.log(
          `  ▣ checkpoint ${event.ref?.slice(0, 10)} — ${event.label ?? ""}`,
        );
        break;
      case "run_finished":
        console.log(`\n══ finished · ok=${event.ok} · ${event.reason ?? ""}`);
        if (event.summary) console.log(indent(cut(event.summary, 2000), "   "));
        break;
      // reasoning/text deltas are folded into their finished events — skip.
    }
  }
}

for (const file of files) {
  try {
    showAnchor(file);
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : error}`);
  }
}
