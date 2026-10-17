/**
 * The engine's event stream.
 *
 * One structured union describing everything that happens in a run. Consumers
 * subscribe via `onEvent`: the CLI prints it, the trace layer (step 8) persists
 * it as the journal, the dashboard/chat SSE (steps 17–18) relay it. The engine
 * itself never formats anything — it only emits.
 */
import type { LLMUsage } from "../llm/types.js";

export type AgentEvent =
  | { type: "run_started"; task: string; phases: string[] }
  | { type: "phase_started"; phase: string }
  | { type: "llm_call_started"; phase: string; step: number }
  | { type: "llm_text_delta"; text: string }
  | {
      type: "llm_call_finished";
      phase: string;
      step: number;
      textChars: number;
      toolCalls: number;
      usage: LLMUsage;
      latencyMs: number;
    }
  | { type: "tool_call"; phase: string; step: number; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      phase: string;
      step: number;
      name: string;
      ok: boolean;
      contentChars: number;
      meta?: Record<string, unknown>;
    }
  | { type: "guardrail"; kind: "loop_detected" | "budget_exceeded"; detail: string }
  | {
      type: "run_finished";
      ok: boolean;
      summary?: string;
      steps: number;
      usage: LLMUsage;
      reason: "finished" | "max_steps" | "budget_exceeded" | "stalled" | "error";
    }
  | { type: "error"; message: string };

export type EventSink = (event: AgentEvent) => void;
