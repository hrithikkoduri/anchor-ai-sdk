/**
 * createLiveProjector — small, safe frames for live consumers (SSE/websocket)
 * of the event stream: cumulative assistant text at ~10/s, activity markers,
 * step-scoped snapshots.
 *
 * A TraceSink, so it versions with the event schema and shares the fanout's
 * sequencing — `sequence` on the wire IS the journal seq, which is what lets
 * a reconnecting dashboard splice live frames onto replayed conversation
 * parts (see conversation.ts). Redaction is the fanout's job: frames are
 * built from entries that were already redacted.
 *
 * Fire-and-forget by design — keep the live path independent of slow journal
 * writes; the trace is the truth.
 */
import type { TraceSink, TracedEvent } from "./sink.js";

/** One model stream's running state: the leader's, or one delegated worker's. */
interface Stream {
  step: number;
  text: string;
  reasoning: string;
  lastText: number;
  lastReasoning: number;
}

const stream = (): Stream => ({
  step: 0,
  text: "",
  reasoning: "",
  lastText: Number.NEGATIVE_INFINITY,
  lastReasoning: Number.NEGATIVE_INFINITY,
});

export function createLiveProjector(
  send: (payload: Record<string, unknown>) => void,
  now = Date.now,
): TraceSink {
  // Workers delegated in parallel interleave their deltas, so cumulative
  // text and the step are kept per stream: the leader is "", a worker is its
  // delegate call. Frames from a worker say so (agent, worker, delegateCallId)
  // and a consumer renders them inside that delegation, not as the leader.
  const streams = new Map<string, Stream>();
  return {
    name: "live",
    record(entry: TracedEvent) {
      const event = entry.event;
      const key = event.delegateCallId ?? "";
      let state = streams.get(key);
      if (!state) streams.set(key, (state = stream()));
      if ("step" in event) state.step = event.step;
      const step = state.step;
      const attribution = {
        ...(event.agent && event.delegateCallId ? { agent: event.agent } : {}),
        ...(event.worker ? { worker: event.worker } : {}),
        ...(event.role ? { role: event.role } : {}),
        ...(event.delegateCallId ? { delegateCallId: event.delegateCallId } : {}),
      };
      const publish = (payload: Record<string, unknown>) =>
        send(
          // The JSON round-trip both normalizes the frame (undefined fields
          // drop) and pins the wire shape the dashboard expects.
          JSON.parse(
            JSON.stringify({ sequence: entry.seq, step, ...attribution, ...payload }),
          ) as Record<string, unknown>,
        );
      switch (event.type) {
        case "run_started":
          publish({ kind: "started", phases: event.phases });
          break;
        case "llm_call_started":
          state.text = "";
          state.reasoning = "";
          state.lastText = Number.NEGATIVE_INFINITY;
          state.lastReasoning = Number.NEGATIVE_INFINITY;
          publish({ kind: "llm_started", phase: event.phase });
          break;
        case "llm_text_delta":
          state.text += event.text;
          if (now() - state.lastText >= 100) {
            state.lastText = now();
            publish({ kind: "delta", text: state.text });
          }
          break;
        case "llm_reasoning_delta":
          state.reasoning += event.text;
          if (now() - state.lastReasoning >= 100) {
            state.lastReasoning = now();
            publish({ kind: "reasoning", text: state.reasoning });
          }
          break;
        case "llm_call_finished":
          publish({
            kind: "assistant_done",
            text: event.text,
            // Send reasoning only when it is actually something: an empty
            // string or 0 tokens is the provider's default, not a block.
            ...(event.reasoning?.trim()
              ? { reasoning: event.reasoning }
              : {}),
            ...(event.usage.reasoningTokens !== undefined &&
            event.usage.reasoningTokens > 0
              ? { reasoningTokens: event.usage.reasoningTokens }
              : {}),
          });
          break;
        case "compacted":
          publish({
            kind: "compacted",
            removedMessages: event.removedMessages,
            keptMessages: event.keptMessages,
            summaryChars: event.summaryChars,
            summary: event.summary,
            folding: event.folding,
          });
          break;
        case "tool_call":
          publish({
            kind: "tool_call",
            callId: event.callId,
            name: event.name,
            verb: event.verb,
            input: event.input,
          });
          break;
        case "tool_result":
          publish({
            kind: "tool_result",
            callId: event.callId,
            name: event.name,
            verb: event.verb,
            ok: event.ok,
            content: event.content.slice(0, 4000),
          });
          break;
        case "phase_started":
          publish({ kind: "phase", phase: event.phase });
          break;
        case "run_finished":
          publish({
            kind: "run_finished",
            summary: event.summary,
            ok: event.ok,
            reason: event.reason,
          });
          if (key) streams.delete(key);
          break;
        case "error":
          publish({ kind: "error", message: event.message });
          break;
      }
    },
  };
}
