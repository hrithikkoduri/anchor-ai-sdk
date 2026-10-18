/**
 * The engine's event stream.
 *
 * One structured union describing everything that happens in a run. Consumers
 * subscribe via `onEvent`: the CLI prints it, the trace layer (step 8) persists
 * it as the journal, the dashboard/chat SSE (steps 17–18) relay it. The engine
 * itself never formats anything — it only emits.
 */
import type { LLMToolCall, LLMUsage } from "../llm/types.js";

/** How a finish() concluded — done, watching for events, or blocked on a human. */
export type RunDisposition = "done" | "watch" | "blocked";

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
  | { type: "tool_call"; phase: string; step: number; name: string; input: Record<string, unknown>; callId?: string; verb?: string }
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
  | { type: "guardrail"; kind: "loop_detected" | "budget_exceeded" | "finish_rejected" | "transition_rejected" | "check_overridden"; detail: string }
  | { type: "checkpoint"; ref: string; label: string }
  | {
      type: "compacted";
      removedMessages: number;
      keptMessages: number;
      summaryChars: number;
      usage: LLMUsage;
    }
  | {
      type: "run_finished";
      ok: boolean;
      summary?: string;
      steps: number;
      usage: LLMUsage;
      reason: "finished" | "max_steps" | "budget_exceeded" | "stalled" | "error" | "paused" | "cancelled";
      /** Set when the run concluded via finish(): done | watch | blocked. */
      disposition?: RunDisposition;
    }
  | { type: "error"; message: string };

export type EventSink = (event: AgentEvent) => void;
