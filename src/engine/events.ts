/**
 * The engine's event stream.
 *
 * One structured union describing everything that happens in a run. Consumers
 * subscribe via `onEvent`: the CLI prints it, the trace layer (step 8) persists
 * it as the journal, the dashboard/chat SSE (steps 17–18) relay it. The engine
 * itself never formats anything — it only emits.
 */
import type { LLMMessage, LLMToolCall, LLMUsage } from "../llm/types.js";
import type { CompactionHandoff } from "./compaction.js";
import type { ProgressLedger } from "../ledger/types.js";

/** What a budget-limited run says it still needs — see EngineOptions.revival. */
export interface RevivalRequest {
  /** Plain language: the work that remains. */
  remaining: string;
  /** The run's own estimate for the next run. Never trusted blindly. */
  estimatedSteps?: number;
  estimatedTokens?: number;
}

type AgentEventBody =
  | {
      type: "run_started";
      /** Human-readable text of this turn's input messages. */
      text: string;
      /** The input message delta, when the consumer supplied messages. */
      messages?: LLMMessage[];
      phases: string[];
    }
  | { type: "task_created"; ledger: ProgressLedger }
  | {
      type: "phase_verdict";
      phase: string;
      cleared: boolean;
      confidence: number;
      judge: string;
      requirements: Array<{
        id: string;
        status: "cleared" | "insufficient" | "unproven";
        probability?: number;
      }>;
    }
  | {
      type: "phase_started";
      phase: string;
      /** Set when the agent drove the move: checked, ungated (trusted), or forced over a denied check. */
      via?: "advance" | "advance_unverified" | "advance_forced";
    }
  | { type: "llm_call_started"; phase?: string; step: number }
  | { type: "llm_text_delta"; text: string }
  | { type: "llm_reasoning_delta"; text: string }
  | {
      type: "llm_call_finished";
      phase?: string;
      step: number;
      /** The full assistant turn — with toolCalls, this reconstructs the conversation (journal). */
      text: string;
      reasoning?: string;
      toolCalls: LLMToolCall[];
      textChars: number;
      toolCallsCount: number;
      usage: LLMUsage;
      latencyMs: number;
      /** Model id the provider said it served, when the response carried one. */
      model?: string;
      /** Upstream name, when a gateway reported one. */
      provider?: string;
    }
  | {
      type: "tool_call";
      phase?: string;
      step: number;
      name: string;
      input: Record<string, unknown>;
      callId?: string;
      /** The idempotency identity minted before an effectful call. */
      operationId?: string;
      verb?: string;
    }
  | {
      /** The target ACCEPTED an effectful request; its result is not known yet. */
      type: "tool_ack";
      phase?: string;
      step: number;
      name: string;
      callId?: string;
      operationId: string;
      ack: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      phase?: string;
      step: number;
      name: string;
      callId?: string;
      operationId?: string;
      verb?: string;
      ok: boolean;
      /**
       * `"unknown"` means the effect may or may not have landed. It is not a
       * failure and must not be retried automatically.
       */
      outcome?: "completed" | "failed" | "unknown";
      /** The actual result text (already truncated by the tool) — journal material. */
      content: string;
      contentChars: number;
      meta?: Record<string, unknown>;
    }
  | {
      /** A pending operation from a crashed run was resolved during recovery. */
      type: "reconciled";
      operationId: string;
      tool: string;
      status: "applied" | "not_applied" | "unknown";
      detail?: string;
    }
  | {
      /** A command outlived `backgroundAfterSecs` and is still running. The
       * consumer persists this handle and delivers the result later; the
       * engine itself neither polls nor waits. */
      type: "background_started";
      jobId: string;
      tool: string;
      callId?: string;
      command?: string;
      /** The job's hard lifetime — the consumer's lost-receipt deadline. */
      timeoutSecs?: number;
    }
  | {
      /** A background job's result was injected into the conversation. */
      type: "background_completed";
      jobId: string;
      tool: string;
      exitCode: number;
      timedOut: boolean;
    }
  | {
      /** A claimed inbox batch became this run's task (decision #82). */
      type: "inbox_delivered";
      messages: Array<{ id: string; delivery: "queue" | "interject" }>;
    }
  | {
      /**
       * A pending interjection ended the previous run at its turn boundary.
       * Which messages caused it is reported by the next `inbox_delivered`.
       */
      type: "inbox_interject";
    }
  | {
      type: "guardrail";
      kind:
        | "loop_detected"
        | "budget_exceeded"
        | "finish_rejected"
        | "transition_rejected"
        | "check_overridden";
      detail: string;
    }
  | {
      /**
       * Live progress from a delegated child, once per its turn. Compact on
       * purpose — never a transcript. Attribution (`agent`, `parentAgent`,
       * `delegateCallId`) rides the envelope; `worker` is repeated here so a
       * consumer reading only the body can key by worker.
       */
      type: "progress";
      worker: string;
      steps: number;
      /** Fraction of the child's own budget used, 0..1. */
      budgetUsed: number;
      /** The last tool the child called this turn, if any. */
      lastTool?: string;
      /** The last tool's activity label — what the child is doing. */
      lastVerb?: string;
      /** The child's last visible assistant line, trimmed (~200 chars). */
      lastText?: string;
      /** Paths the child has touched, deduped and capped. */
      filesTouched?: string[];
      /** True on the record reporting a silent child (see `stalledForMs`). */
      stalled?: boolean;
      /** How long the child had produced no event when this record was sent. */
      stalledForMs?: number;
    }
  | {
      /** Non-blocking runtime guidance (e.g. the materialization advisory).
       * Advisory events never gate actions or end runs. */
      type: "advisory";
      kind:
        | "materialization_nudge"
        | "budget_warning"
        | "child_wrap_up"
        | "snapshot_failed"
        | "output_truncated"
        | "output_cap_continue"
        | "verbose_turn"
        | "assistant_text_elided"
        | "tool_results_elided"
        | "prose_checkpoint"
        | "repeated_call"
        | "empty_turn"
        | "effect_without_journal"
        | "operation_settle_failed"
        | "verifier_failed";
      detail: string;
    }
  | {
      /** The dying run's handoff: what it still needs, for a consumer that may
       * choose to fund a revival run. The engine itself grants nothing. */
      type: "revival_requested";
      request: RevivalRequest;
    }
  | {
      type: "checkpoint";
      ref: string;
      label: string;
      /** Branch the checkpoint was pushed to, when durability was requested. */
      pushedTo?: string;
      /** Why an off-machine push failed (the commit itself still exists). */
      pushError?: string;
    }
  | {
      type: "compacted";
      removedMessages: number;
      keptMessages: number;
      summaryChars: number;
      /** The summary that replaced the folded span — the compaction's output. */
      summary?: string;
      /** Structured handoff used by a task/ledger reset. */
      compaction?: CompactionHandoff;
      /** Truncated transcript of the folded span — the compaction's input. */
      folding?: string;
      usage: LLMUsage;
    }
  | {
      type: "run_finished";
      ok: boolean;
      summary?: string;
      steps: number;
      usage: LLMUsage;
      reason:
        | "finished"
        | "max_steps"
        | "budget_exceeded"
        | "budget_exhausted"
        | "stalled"
        | "error"
        | "paused"
        | "cancelled"
        | "interrupted"
        | "recovery_required";
      /** Set when the run concluded via finish() with a consumer-shaped handoff. */
      handoff?: Record<string, unknown>;
    }
  | { type: "error"; message: string };

export type AgentEvent = AgentEventBody & {
  /** Agent bundle that emitted this event. */
  agent?: string;
  /** Parent agent when this event belongs to a delegated child. */
  parentAgent?: string;
  /** Tool-call id of the delegate invocation that started the child. */
  delegateCallId?: string;
  /** Worker instance of a delegated child ("frontend-2"); `agent` is its roster member. */
  worker?: string;
  /** Team role of a delegated child. */
  role?: "worker" | "evaluator";
};

export type EventSink = (event: AgentEvent) => void;
