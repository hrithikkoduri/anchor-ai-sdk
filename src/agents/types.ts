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
import type { AgentStrategy } from "../engine/strategy.js";
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
}
