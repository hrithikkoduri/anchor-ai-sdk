/**
 * The `anchor` arm — the framework's own coding agent, composed from
 * `anchor-ai-sdk` primitives and nothing else.
 *
 * This is the system under test: codingAgent's strategy and tools (the same
 * plan → act → verify loop Sailor runs on threads), with the benchmark
 * context — repository, workspace, base commit, deliverable — added HERE, in
 * the app. No product code is imported; `evals` stays a pure second
 * consumer of the package.
 */
import {
  buildCodingPrompt,
  codingAgent,
  runAgent,
  type Agent,
} from "anchor-ai-sdk";
import type { EvalArm, EvalArmContext } from "../runner.js";
import type { EvalTask } from "../tasks.js";

/**
 * The eval adds block overrides + one new block. The package defaults are a
 * colleague's operating philosophy (proportionate effort, honest stopping) —
 * correct for the product. A benchmark is a scored fight: the project's own
 * tests decide it, so the agent keeps attacking until they pass. These blocks
 * apply only here; the package prompt is untouched for product use.
 */
export const EVAL_TONE = [
  "Be direct, relentless, and specific. This run is a fight against a failing behavior:",
  "every unverified claim is a lost position, every passing test a captured one.",
  "Lead with outcomes and evidence. No filler, no theater, no excuses — report only what this run verified.",
].join(" ");

export const EVAL_JUDGMENT = [
  "The latest request defines the work. Inspect the actual repository instead of debating hypothetical constraints.",
  "When an approach fails, use the new evidence to adapt immediately — do not stop while a known failure remains.",
  "Change direction only on new evidence. Finish only when the failing behavior is fixed and proven.",
].join(" ");

export const EVAL_VERIFICATION = [
  "Verification is how you win: reproduce the failure, fix it, then prove it —",
  "run the relevant tests and your repro before and after, and reproduce any exact outputs the report shows.",
  "Never claim unrun tests passed; mark anything unverified as a hypothesis.",
  "A failing or missing relevant check means the work is not done — keep going until it passes.",
].join(" ");

const BENCHMARK_DISCIPLINE = [
  "This run is a scored battle decided exactly and only by the project's own tests. Keep attacking until the change is complete and verified:",
  "- Keep issuing commands, reading their results, and iterating. Do not end the run with a mid-work status report while anything the report describes remains unimplemented or unverified.",
  "- Workflow: (1) locate the relevant code and tests; (2) reproduce the reported behavior with a command; (3) make the minimal source change; (4) run the relevant test FILES and your repro; (5) check edge cases and reproduce any exact outputs or formats the report shows, byte for byte.",
  "- Do not modify test files or leave scratch files; keep the final diff to source changes that fix the reported behavior.",
  "- Keep your working-notes file (.anchor/notes.md) current and reconcile it before finishing — every unverified requirement written on it is unfinished work.",
].join("\n");

export function anchorArm(): EvalArm {
  return {
    name: "anchor",
    async run(task: EvalTask, ctx: EvalArmContext) {
      const context = JSON.stringify(
        {
          repository: task.repoUrl,
          workspace: ctx.sandbox.workspace,
          baseCommit: task.baseRef,
          note: [
            "A benchmark task: make the requested change in this repository; the workspace diff is the deliverable (no remote, no publication).",
            "The environment is ALREADY provisioned: the project's dependencies live in a ready Python environment — try /opt/miniconda3/envs/testbed/bin/python first (bare python/pip may not see them). Do NOT reinstall the project.",
            "The project's own tests are the source of truth. Find and run the tests that cover the reported behavior before and after your change — and run the relevant test FILES, not only your own repro: breaking neighboring behavior counts against you.",
            "When the report shows an exact expected output or format, reproduce it verbatim in your repro and compare against it.",
            "Re-read the report before finishing and cover EVERY requirement it names — including 'this was already added for X and should also apply to Y' style twins. Do not finish while any relevant test fails.",
          ].join(" "),
        },
        null,
        2,
      );
      // Compose the prompt here (the block system is the point): the package
      // defaults, plus the benchmark-discipline block this eval needs.
      const agent: Agent = {
        ...codingAgent,
        name: "anchor",
        strategy: {
          ...codingAgent.strategy,
          systemPrompt: (args) =>
            buildCodingPrompt({
              tone: EVAL_TONE,
              judgment: EVAL_JUDGMENT,
              verification: EVAL_VERIFICATION,
              context: [context, args.context].filter(Boolean).join("\n\n"),
              ...(args.summary ? { summary: args.summary } : {}),
              additionalSections: [
                { title: "Benchmark discipline", body: BENCHMARK_DISCIPLINE },
              ],
            }),
        },
      };
      const outcome = await runAgent(
        { task: task.problem },
        {
          llm: ctx.llm,
          sandbox: ctx.sandbox,
          agent,
          ...(ctx.budgets ? { budgets: ctx.budgets } : {}),
          ...(ctx.compaction ? { compaction: ctx.compaction } : {}),
          ...(ctx.onEvent ? { onEvent: ctx.onEvent } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
      );
      return {
        usage: outcome.usage,
        steps: outcome.steps,
        reason: outcome.reason,
        summary: outcome.summary,
      };
    },
  };
}
