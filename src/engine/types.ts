import type { Agent } from "../agents/types.js";
import type {
  LLMClient,
  LLMMessage,
  LLMUsage,
  ReasoningEffort,
} from "../llm/types.js";
import type { Sandbox } from "../sandbox/types.js";
import type { Tool } from "../tools/types.js";
import type { TraceSink } from "../trace/sink.js";
import type { BudgetLimits } from "./budgets.js";
import type { CompactionConfig } from "./compaction.js";
import type { EventSink, RevivalRequest } from "./events.js";
import type { AgentStrategy, ToolResultRecord } from "./strategy.js";
import type { ThreadStore } from "./thread.js";
import type { InboxMessage, InboxStore, RunSummary } from "./inbox.js";
import type { OperationStore, PendingOperation } from "./operations.js";

export interface RunTask {
  task: string;
  context?: string;
}

/**
 * A command still running in the sandbox after `backgroundAfterSecs`. The
 * engine tracks these, polls them at turn boundaries, and injects their
 * results as runtime-only messages. Providers without `pollJob` never produce
 * one (bash does not detach there).
 */
export interface BackgroundJob {
  jobId: string;
  tool: string;
  command?: string;
  /** Epoch ms at launch; the provider needs it to re-adopt the receipt. */
  startedAt: number;
  /** The job's hard lifetime, used to bound the wait. */
  timeoutSecs?: number;
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
   * Default `DEFAULT_MAX_OUTPUT_TOKENS` (16k); pass `false` to leave output
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
  /**
   * Jobs still running when a previous run ended. The engine polls them from
   * the first turn boundary, so a consumer that woke this run can hand its
   * `pendingJobs` straight back.
   */
  resumeJobs?: BackgroundJob[];
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
  /**
   * Sampling pin for this run. Absent fields are left unset, so the provider
   * default applies. Set both for a benchmark that must not drift between
   * upstreams.
   */
  sampling?: { temperature?: number; seed?: number };
  /**
   * How much reasoning the model may spend per call (`minimal` … `xhigh`).
   * Explicit option wins over the agent bundle's suggestion. Sent as the
   * provider's native shape by the LLM client.
   */
  reasoningEffort?: ReasoningEffort;
  /** External abort (fast in-process path). Merged with `cancel` polling. */
  signal?: AbortSignal;
  thread?: { store: ThreadStore; id: string };
  /**
   * Deliver messages that arrive while this run works (decision #82). The
   * engine probes for interjections at every turn boundary and, when the run
   * ends, claims the pending batch and starts the next run with it — same
   * thread, sandbox, and budget. Absent: today's behavior exactly, one run.
   *
   * The store is the consumer's; `MemoryInboxStore` ships for tests and
   * single-process apps. Ordering and claim semantics are the store's
   * contract (see `InboxStore`).
   */
  inbox?: {
    store: InboxStore;
    /** Work-stream key — usually the thread id. */
    channel: string;
    /** Build the next run's task from a claimed batch. Default joins text. */
    render?: (messages: InboxMessage[]) => { task: string; context?: string };
  };
  /**
   * Durable recovery for tools that declare an `effect` (external writes).
   * The engine records the intent BEFORE the tool runs, mints an
   * `operationId` the tool forwards as an idempotency key, and settles the
   * record after. On resume, pending operations are reconciled; an ambiguous
   * outcome stops the run with `reason: "recovery_required"` instead of being
   * replayed. Absent: effectful tools still run, with an advisory (today's
   * behavior, no crash protection).
   *
   * The store is the consumer's. `scope` defaults to the thread id; one of the
   * two is required when a store is supplied.
   */
  operations?: {
    store: OperationStore;
    /** Recovery scope — usually the thread id. Default: `thread.id`. */
    scope?: string;
  };
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
   * The mirror of `toolOnlyNudgeLimit`: when one turn's VISIBLE output (text
   * and tool-call arguments) exceeds this many tokens, inject one
   * runtime-only advisory — a status line now, act next (default 8_000;
   * false disables). Reasoning tokens are excluded: they are hidden and a
   * thinking model must not be told to stop thinking. Keep it below
   * `maxOutputTokens` so it can course-correct before the hard stop.
   * Advisory only.
   */
  verboseTurnLimit?: number | false;
  /**
   * A prose-only turn is read as the model's final answer. After tool work it
   * can just as easily be a mid-task status report, and the loop cannot tell
   * the two apart from shape alone. When the agent has a declared-completion
   * tool (`finish`), ask once before accepting prose as the result: call
   * `finish`, take another action, or repeat the reply (default true; false
   * disables). One-shot — it never turns into a loop.
   */
  proseCheckpoint?: boolean;
}

export type FinishReason =
  | "finished"
  | "max_steps"
  | "budget_exceeded"
  | "stalled"
  | "error"
  | "paused"
  | "cancelled"
  /**
   * A pending inbox interjection ended the run at a turn boundary. The chain
   * continues with the message it claimed; a standalone run (no inbox) never
   * reports this.
   */
  | "interrupted"
  /**
   * Recovery found an operation whose outcome is unknown (a crash between the
   * external write and its result). The run stops BEFORE the next model turn,
   * so the write cannot be replayed silently. Resolve it (the tool's
   * `effect.reconcile` or a human) and run again.
   */
  | "recovery_required";

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
  /**
   * Every run a chained `runAgent` call performed, oldest first, including
   * this final one. Absent when no `inbox` was configured (a single run).
   */
  runs?: RunSummary[];
  /**
   * Commands still running when the run ended. Pass them back as
   * `resumeJobs` to keep polling them; otherwise their results are lost.
   */
  pendingJobs?: BackgroundJob[];
  /**
   * External operations with an UNKNOWN outcome. Present when the run ended
   * with `reason: "recovery_required"`; never retried automatically.
   */
  pendingOperations?: PendingOperation[];
  phase?: string;
  /** Opaque, consumer-shaped handoff from finish(); the engine only carries it. */
  handoff?: Record<string, unknown>;
}
