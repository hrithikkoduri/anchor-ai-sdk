import type { Agent } from "../agents/types.js";
import type { LLMClient, LLMMessage, LLMUsage } from "../llm/types.js";
import type { Sandbox } from "../sandbox/types.js";
import type { Tool } from "../tools/types.js";
import type { TraceSink } from "../trace/sink.js";
import type { BudgetLimits } from "./budgets.js";
import type { CompactionConfig } from "./compaction.js";
import type { EventSink, RevivalRequest, RunDisposition } from "./events.js";
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
  /**
   * Branch that turn-boundary checkpoints are force-pushed to (off-machine
   * durability: a lost sandbox must not lose the work). Push failures are
   * reported on the checkpoint event, never fatal to the run.
   */
  checkpointPushRef?: string;
  /**
   * Budget revival (absent or false = OFF; consumers opt in). Near
   * `warnAtPercent`% of the run's budget the engine injects one warning and
   * offers the `request_revival` handoff tool; a budget-exhausted ending then
   * carries the request on AgentResult.revival. The engine grants nothing —
   * funding a revival run is the consumer's decision.
   */
  revival?: { warnAtPercent?: number } | false;
  startPhase?: string;
  onEvent?: EventSink;
  /**
   * Durable sinks. The engine owns their sequence number (one fanout per run)
   * and applies redaction once, before every sink; a broken sink never kills
   * the run, and all sinks are flushed before runAgent resolves. `onEvent`
   * still receives raw events for live consumers.
   */
  traceSinks?: TraceSink[];
  /**
   * Keep something alive while the run executes — a lease, a lock, a queue
   * item. The first beat fires immediately; failures are swallowed; the timer
   * is stopped when the run ends, however it ends.
   */
  heartbeat?: { everyMs?: number; beat: () => void | Promise<void> };
  /**
   * Poll for an out-of-band cancel — e.g. a durable flag any process can set.
   * Truthy → the run aborts and concludes "cancelled". The caller's `signal`
   * remains the fast in-process path; this is the cross-process one.
   */
  cancel?: { everyMs?: number; isCancelled: () => boolean | Promise<boolean> };
  /** External abort (fast in-process path). Merged with `cancel` polling. */
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
  /** Present when the run ended out of budget and revival is enabled. */
  revival?: RevivalRequest;
  phase?: string;
  disposition?: RunDisposition;
  watch?: Record<string, unknown>;
  resumeAt?: string;
}
