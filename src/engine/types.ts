import type { Agent } from "../agents/types.js";
import type { LLMClient, LLMMessage, LLMUsage } from "../llm/types.js";
import type { Sandbox } from "../sandbox/types.js";
import type { Tool } from "../tools/types.js";
import type { TraceSink } from "../trace/sink.js";
import type { BudgetLimits } from "./budgets.js";
import type { CompactionConfig } from "./compaction.js";
import type { EventSink, RevivalRequest } from "./events.js";
import type { AgentStrategy, ToolResultRecord } from "./strategy.js";
import type { ThreadStore } from "./thread.js";

export interface RunTask {
  task: string;
  context?: string;
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
  /**
   * Per-call cap on one model response (reasoning + text + tool calls).
   * Default `DEFAULT_MAX_OUTPUT_TOKENS` (12k); pass `false` to leave output
   * unbounded. Explicit option wins over the agent bundle's suggestion.
   *
   * This is a hard stop, not a nudge: a response that hits it ends with
   * finishReason "length", and the engine emits an `output_truncated`
   * advisory so a chopped reply (or a lost tool call) is never silent.
   */
  maxOutputTokens?: number | false;
  /**
   * Replay budget for the assistant's OWN text, in chars (default 20_000;
   * `false` disables). Oversized replies keep a head and a tail with the full
   * text spilled to scratch and pointed at; a reply cut off by
   * `maxOutputTokens` keeps only its head, because its tail is mid-token.
   *
   * This bounds what is SENT to the provider. The stored transcript
   * (`AgentResult.messages`) and the event stream keep the full text.
   */
  maxAssistantChars?: number | false;
  /**
   * Tighter replay budget (chars) for a turn that hit `maxOutputTokens`, since
   * its text stops mid-token and only the head is worth replaying. Default
   * `DEFAULT_TRUNCATED_REPLY_CHARS` (12_000); `false` drops the stricter rule and
   * treats a capped turn like any other. Never raises the effective budget
   * above `maxAssistantChars`.
   */
  truncatedReplyChars?: number | false;
  compaction?: CompactionConfig | false;
  guardrails?: GuardrailConfig;
  /** Caller-controlled pause when the agent leaves a named phase. */
  pauseAfterPhase?: string;
  /**
   * Snapshot changed work at run boundaries (finish/pause), without empty
   * commits. Default: the package's `gitSnapshot()` — a git commit via the
   * sandbox, no push. Pass your own to snapshot differently (a remote push, an
   * artifact store, another VCS) or `false` to turn snapshots off. Whatever
   * it returns is surfaced on the checkpoint event and
   * `AgentResult.checkpointRef`; a throw is best-effort and never fatal.
   */
  snapshot?: SnapshotFn | false;
  /**
   * Budget revival (absent or false = OFF; consumers opt in). Near
   * `warnAtPercent`% of the run's budget the engine injects one warning and
   * offers the `request_revival` handoff tool; a budget-exhausted ending then
   * carries the request on AgentResult.revival. The engine grants nothing —
   * funding a revival run is the consumer's decision.
   */
  revival?: { warnAtPercent?: number } | false;
  /**
   * The consumer's handoff shape for finish(). When present, finish() declares
   * a `handoff` parameter with `schema` (a JSON-schema object the model must
   * conform to) and the engine carries the model's object to
   * `AgentResult.handoff` untouched — the engine never interprets it.
   * `threadPhase` tells the engine which phase a thread should resume at,
   * derived from the handoff (absent → the run's own phase persists).
   */
  handoff?: {
    schema: Record<string, unknown>;
    description?: string;
    threadPhase?: (handoff: Record<string, unknown>) => string | undefined;
  };
  startPhase?: string;
  /**
   * Let long-running shell commands outlive the turn. When set, `bash` asks
   * the sandbox to detach at this many seconds and returns control with a job
   * handle; the engine emits `background_started` and the consumer delivers
   * the completion later (typically as a new inbox turn). Unset = today's
   * fully synchronous behavior. Requires a sandbox with `pollJob` (heyo).
   */
  backgroundAfterSecs?: number;
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

/** What a snapshot produced — the engine reports it, never interprets it. */
export interface SnapshotResult {
  /** The snapshot's identity (a commit sha, an artifact id, …). */
  ref: string;
  /** Where it was pushed, when the implementation pushes anywhere. */
  pushedTo?: string;
  /** A push that failed — reported, never thrown (durability is best-effort). */
  pushError?: string;
}

/**
 * How a consumer snapshots changed work. The engine calls it at run
 * boundaries and reports what comes back; it never assumes git.
 */
export type SnapshotFn = (context: {
  /** Why the snapshot is being taken. */
  reason: "finish" | "pause";
  /** Human label for the trace, e.g. "turn boundary". */
  label: string;
  sandbox: Sandbox;
}) => SnapshotResult | undefined | Promise<SnapshotResult | undefined>;

export interface GuardrailConfig {
  /** Stop repeated identical calls (default 3); false disables this limit. */
  repeatedToolCallLimit?: number | false;
  /**
   * After this many consecutive tool-call turns with no visible text, inject
   * one runtime-only advisory asking for a reply or a visible status (default
   * 8; false disables). Advisory only — it never blocks or ends the run.
   */
  toolOnlyNudgeLimit?: number | false;
  /**
   * The mirror of `toolOnlyNudgeLimit`: when one turn's output exceeds this
   * many tokens (reasoning + text + tool calls, as the provider reports it),
   * inject one runtime-only advisory — a status line now, act next (default
   * 8_000; false disables). Keep it below `maxOutputTokens` so it can
   * course-correct before the hard stop. Advisory only.
   */
  verboseTurnLimit?: number | false;
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
  /** Opaque, consumer-shaped handoff from finish(); the engine only carries it. */
  handoff?: Record<string, unknown>;
}
