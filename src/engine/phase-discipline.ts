/**
 * Phase discipline — the engine's half: a prompt block that makes the phase
 * label mean something. `set_phase` is an intrinsic tool (it lives in the
 * loop); this is the intrinsic text that explains why to use it.
 *
 * It is deliberately generic. The engine knows a strategy's phase ids and
 * nothing about its tools or what those phases mean to a given consumer, so
 * the block can demand focus and honesty without assuming that "act" means
 * editing or that any particular tool implies a transition. The gate is the
 * same `intrinsics.phase` switch that registers the tool, so a consumer that
 * does not want phases turns off one flag and loses both together.
 */
import type { StrategyPhase } from "./strategy.js";

export function phaseDisciplineBlock(phases: StrategyPhase[]): string {
  return [
    "## Staying on phase",
    "Phases are how you keep yourself focused: each names the kind of work you are doing right now, so you can tell whether you are still working the current problem or have drifted into another one.",
    "Keep the phase true. When the kind of work changes — investigating, deciding, executing, verifying, answering — record the new phase before you continue. Never leave a stale label: a phase that no longer describes the work tells the reader, and any later run, something false about where things stand.",
    `Your phases: ${phases.map((phase) => phase.id).join(", ")}. Labeling is one call, and it is part of doing the work well — not bookkeeping to skip under time pressure.`,
  ].join("\n");
}
