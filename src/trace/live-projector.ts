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

export function createLiveProjector(
  send: (payload: Record<string, unknown>) => void,
  now = Date.now,
): TraceSink {
  let step = 0;
  let text = "";
  let reasoning = "";
  let lastText = Number.NEGATIVE_INFINITY;
  let lastReasoning = Number.NEGATIVE_INFINITY;
  return {
    name: "live",
    record(entry: TracedEvent) {
      const event = entry.event;
      if ("step" in event) step = event.step;
      const publish = (payload: Record<string, unknown>) =>
        send(
          // The JSON round-trip both normalizes the frame (undefined fields
          // drop) and pins the wire shape the dashboard expects.
          JSON.parse(
            JSON.stringify({ sequence: entry.seq, step, ...payload }),
          ) as Record<string, unknown>,
        );
      switch (event.type) {
        case "run_started":
          publish({ kind: "started", phases: event.phases });
          break;
        case "llm_call_started":
          text = "";
          reasoning = "";
          lastText = Number.NEGATIVE_INFINITY;
          lastReasoning = Number.NEGATIVE_INFINITY;
          publish({ kind: "llm_started", phase: event.phase });
          break;
        case "llm_text_delta":
          text += event.text;
          if (now() - lastText >= 100) {
            lastText = now();
            publish({ kind: "delta", text });
          }
          break;
        case "llm_reasoning_delta":
          reasoning += event.text;
          if (now() - lastReasoning >= 100) {
            lastReasoning = now();
            publish({ kind: "reasoning", text: reasoning });
          }
          break;
        case "llm_call_finished":
          publish({
            kind: "assistant_done",
            text: event.text,
            reasoning: event.reasoning,
            reasoningTokens: event.usage.reasoningTokens,
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
          break;
        case "error":
          publish({ kind: "error", message: event.message });
          break;
      }
    },
  };
}
