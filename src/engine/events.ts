/**
 * The engine's event stream.
 *
 * One structured union describing everything that happens in a run. Consumers
 * subscribe via `onEvent`: the CLI prints it, the trace layer (step 8) persists
 * it as the journal, the dashboard/chat SSE (steps 17–18) relay it. The engine
 * itself never formats anything — it only emits.
 */
import type { LLMToolCall, LLMUsage } from "../llm/types.js";

/** What a budget-limited run says it still needs — see EngineOptions.revival. */
export interface RevivalRequest {
  /** Plain language: the work that remains. */
  remaining: string;
  /** The run's own estimate for the next run. Never trusted blindly. */
  estimatedSteps?: number;
  estimatedTokens?: number;
}

export type AgentEvent =
  | { type: "run_started"; task: string; phases: string[] }
  | {
      type: "phase_started";
      phase: string;
      /** Set when the agent drove the move: checked, ungated (trusted), or forced over a denied check. */
      via?: "advance" | "advance_unverified" | "advance_forced";
    }
  | { type: "llm_call_started"; phase: string; step: number }
  | { type: "llm_text_delta"; text: string }
  | { type: "llm_reasoning_delta"; text: string }
  | {
      type: "llm_call_finished";
      phase: string;
      step: number;
      /** The full assistant turn — with toolCalls, this reconstructs the conversation (journal). */
      text: string;
      reasoning?: string;
      toolCalls: LLMToolCall[];
      textChars: number;
      toolCallsCount: number;
      usage: LLMUsage;
      latencyMs: number;
    }
  | {
      type: "tool_call";
      phase: string;
      step: number;
      name: string;
      input: Record<string, unknown>;
      callId?: string;
      verb?: string;
    }
  | {
      type: "tool_result";
      phase: string;
      step: number;
      name: string;
      callId?: string;
      verb?: string;
      ok: boolean;
      /** The actual result text (already truncated by the tool) — journal material. */
      content: string;
      contentChars: number;
      meta?: Record<string, unknown>;
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
      /** Non-blocking runtime guidance (e.g. the materialization advisory).
       * Advisory events never gate actions or end runs. */
      type: "advisory";
      kind: "materialization_nudge" | "budget_warning" | "snapshot_failed";
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
        | "stalled"
        | "error"
        | "paused"
        | "cancelled";
      /** Set when the run concluded via finish() with a consumer-shaped handoff. */
      handoff?: Record<string, unknown>;
    }
  | { type: "error"; message: string };

export type EventSink = (event: AgentEvent) => void;
