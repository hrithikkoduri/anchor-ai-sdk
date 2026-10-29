/**
 * workflowAgent — a headless agent for background jobs that never talk to a
 * user (environment setup, migrations, scheduled maintenance).
 *
 * It is an ordinary bundle (strategy + tools + defaults) plus a
 * `WorkflowContract` the engine enforces with seams it already has:
 *
 * - the system prompt says plainly that no one reads the output and no one
 *   answers; the brief is the whole task;
 * - the conversational nudges (silent-tool, verbose-turn, prose checkpoint)
 *   are off by default; turn-lifecycle guardrails stay on;
 * - `finish` is the only exit, accepted only after the check passed in this
 *   run's own tool log, and only with a schema-valid `output`, which lands on
 *   `AgentResult.output`;
 * - running out of budget (`maxTurns` included) ends as `budget_exhausted`,
 *   a failure;
 * - `ask_questions` is refused, and so are inbox chains and steering.
 */
import type { Tool } from "../../tools/types.js";
import type { AgentStrategy } from "../../engine/strategy.js";
import type { WorkflowContract } from "../../engine/workflow.js";
import type { JSONSchema, OutputSchema } from "../../schema.js";
import type { Agent } from "../types.js";
import { buildWorkflowPrompt } from "./prompt.js";

export { buildWorkflowPrompt } from "./prompt.js";

export interface WorkflowSpec {
  /** Short name for logs and traces: "environment", "migration", … */
  name: string;
  /** Everything the run must achieve. There is no conversation: this must be complete. */
  brief: string;
  /** Domain tools; coding tools are composed by the caller. */
  tools: Tool[];
  /** The proof the run must produce before it may finish. */
  check: { command: string; description: string };
  /** The structured result the run must return; validated, not suggested. */
  output?: {
    name: string;
    schema: OutputSchema;
    /** Shown to the model when `schema` is a zod schema without `toJSONSchema()`. */
    jsonSchema?: JSONSchema;
    description?: string;
  };
  budget?: { maxTurns?: number; maxOutputTokens?: number };
}

const QUESTION_TOOL = "ask_questions";

export function workflowAgent(spec: WorkflowSpec): Agent {
  if (!spec.name.trim()) throw new Error("workflowAgent: name is required");
  if (!spec.brief.trim())
    throw new Error(`workflowAgent "${spec.name}": brief is required — it is the whole task`);
  if (!spec.check.command.trim())
    throw new Error(`workflowAgent "${spec.name}": check.command is required`);
  if (spec.tools.some((tool) => tool.definition.name === QUESTION_TOOL))
    throw new Error(
      `workflowAgent "${spec.name}": ${QUESTION_TOOL} is not allowed — no one answers a workflow's questions`,
    );
  if (!spec.tools.some((tool) => tool.definition.name === "bash"))
    throw new Error(
      `workflowAgent "${spec.name}": a bash tool is required — the check is proven by running it`,
    );
  const { maxTurns, maxOutputTokens } = spec.budget ?? {};
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns <= 0))
    throw new Error(`workflowAgent "${spec.name}": budget.maxTurns must be a positive integer`);

  const strategy: AgentStrategy = {
    name: spec.name,
    phases: [{ id: "run", goal: "achieve the brief and prove it with the check" }],
    requiredTools: ["bash"],
    requiresSandbox: true,
    systemPrompt: ({ context, summary }) =>
      buildWorkflowPrompt(spec, {
        ...(context ? { context } : {}),
        ...(summary ? { summary } : {}),
      }),
  };
  const workflow: WorkflowContract = {
    check: { ...spec.check },
    ...(spec.output ? { output: { ...spec.output } } : {}),
  };
  return {
    name: spec.name,
    strategy,
    tools: [...spec.tools],
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(maxTurns !== undefined ? { budgets: { maxSteps: maxTurns } } : {}),
    guardrails: {
      toolOnlyNudgeLimit: false,
      verboseTurnLimit: false,
      proseCheckpoint: false,
    },
    workflow,
  };
}
