/**
 * The Agent bundle — a strategy plus the tools it can call, in one object.
 *
 * Built-in agents live under `agents/` and are imported ready to run:
 *
 *   import { codingAgent } from "anchor-ai-sdk";
 *   runAgent(task, { llm, sandbox, agent: codingAgent });
 *
 * This is a convenience, not a mode: the engine resolves `agent` into the
 * same `strategy` + `tools` options it always took, and explicit options win
 * per-field. Custom agents are just objects built from the same primitives.
 */
import type { BudgetLimits } from "../engine/budgets.js";
import type { AgentStrategy } from "../engine/strategy.js";
import type { GuardrailConfig } from "../engine/types.js";
import type { WorkflowContract } from "../engine/workflow.js";
import type { ReasoningEffort } from "../llm/types.js";
import type { Tool } from "../tools/types.js";

export interface Agent {
  /** Short display name ("coding", "chat") — logs, dashboards, traces. */
  name: string;
  /** Behavior as data: phases, prompts, advance rules, finish validation. */
  strategy: AgentStrategy;
  /** Capabilities the run may call — a curated subset of the tool registry. */
  tools: Tool[];
  /**
   * Per-call output cap this bundle suggests (see `EngineOptions.maxOutputTokens`).
   * An explicit engine option wins; absent, the engine default applies.
   */
  maxOutputTokens?: number | false;
  /**
   * Reasoning budget this bundle suggests. An explicit
   * `EngineOptions.reasoningEffort` wins; absent, the provider default applies.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Guardrail defaults this bundle suggests. Merged per field under
   * `EngineOptions.guardrails`: an explicit field wins, an absent one falls
   * back to the bundle, then to the engine default.
   */
  guardrails?: GuardrailConfig;
  /**
   * Budget defaults this bundle suggests, merged per field under
   * `EngineOptions.budgets` the same way.
   */
  budgets?: Partial<BudgetLimits>;
  /**
   * Present only on workflow bundles (`workflowAgent`): a headless run with a
   * check-gated, schema-validated finish. The engine enforces it; see
   * engine/workflow.ts.
   */
  workflow?: WorkflowContract;
}
