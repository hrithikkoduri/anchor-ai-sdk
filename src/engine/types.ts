import type { Agent } from "../agents/types.js";
import type { LLMClient, LLMMessage, LLMUsage } from "../llm/types.js";
import type { Sandbox } from "../sandbox/types.js";
import type { Tool } from "../tools/types.js";
import type { BudgetLimits } from "./budgets.js";
import type { CompactionConfig } from "./compaction.js";
import type { EventSink, RunDisposition } from "./events.js";
import type { AgentStrategy, ToolResultRecord } from "./strategy.js";
import type { ThreadStore } from "./thread.js";

export interface RunTask {
  task: string;
  context?: string;
  testCommand?: string;
}

export interface EngineOptions {
  llm: LLMClient;
  agent?: Agent;
  strategy?: AgentStrategy;
  sandbox?: Sandbox;
  tools?: Tool[];
  /** Optional metadata/handoff tools. Neither is needed to end a response. */
  intrinsics?: { finish?: boolean; phase?: boolean };
  budgets?: Partial<BudgetLimits>;
  compaction?: CompactionConfig | false;
  guardrails?: GuardrailConfig;
  /** Caller-controlled pause when the agent leaves a named phase. */
  pauseAfterPhase?: string;
  /** Snapshot changed work at turn/pause boundaries, without empty commits. */
  checkpoints?: boolean;
  startPhase?: string;
  onEvent?: EventSink;
  signal?: AbortSignal;
  thread?: { store: ThreadStore; id: string };
}

export interface GuardrailConfig {
  /** Stop repeated identical calls (default 3); false disables this limit. */
  repeatedToolCallLimit?: number | false;
  /**
   * After this many consecutive tool-call turns with no visible text, inject
   * one runtime-only advisory asking for a reply or a visible status (default
   * 8; false disables). Advisory only — it never blocks or ends the run.
   */
  toolOnlyNudgeLimit?: number | false;
}

export type FinishReason =
  | "finished"
  | "max_steps"
  | "budget_exceeded"
  | "stalled"
  | "error"
  | "paused"
  | "cancelled";

export interface AgentResult {
  /** Runtime outcome only: not a verification certificate or permission to publish. */
  ok: boolean;
  completion?: "response" | "declared";
  evidence: ToolResultRecord[];
  summary?: string;
  reason: FinishReason;
  error?: string;
  steps: number;
  usage: LLMUsage;
  messages: LLMMessage[];
  checkpointRef?: string;
  phase?: string;
  disposition?: RunDisposition;
  watch?: Record<string, unknown>;
  resumeAt?: string;
}
