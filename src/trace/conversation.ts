/**
 * projectConversation — rebuild the ordered chat transcript from the journal
 * (trace_events rows or any `{ seq, type, payload }` stream). Lives next to
 * the event schema: it versions with it, and the replay path it produces
 * quotes the SAME sequence numbers the live projector publishes, so refresh
 * and reconnect splice perfectly (see live-projector.ts).
 */
import { toolVerb } from "../tools/activity.js";

/** Upgrade the old stock labels on replay without rewriting journal rows.
 * Preserve explicit/custom verbs and retain the call's inputs for results. */
function activityVerb(
  name: string,
  input: Record<string, unknown>,
  recorded: unknown,
): string {
  const legacy: Record<string, string> = {
    bash: "Running a command",
    search: "Searching the repository",
    run_tests: "Running tests",
    advance: "Moving to the next phase",
    finish: "Wrapping up",
  };
  return typeof recorded === "string" && recorded !== legacy[name]
    ? recorded
    : toolVerb(name, input);
}

export interface ConversationPart {
  id: string;
  kind: "text" | "reasoning" | "tool" | "compaction";
  step: number;
  sequence: number;
  text?: string;
  reasoningTokens?: number;
  callId?: string;
  name?: string;
  verb?: string;
  input?: Record<string, unknown>;
  content?: string;
  ok?: boolean;
  complete: boolean;
  /** Compaction parts: what was folded and the summary that replaced it. */
  removedMessages?: number;
  keptMessages?: number;
  summaryChars?: number;
  summary?: string;
  folding?: string;
}

/** Reconstruct exactly the same ordered transcript on refresh and reconnect. */
export function projectConversation(
  events: Array<{ seq: number; type: string; payload: unknown }>,
  status: string,
) {
  const parts: ConversationPart[] = [];
  const phases: string[] = [];
  const visited: string[] = [];
  let phase: string | null = null;
  let step = 0;
  let finished = !["running", "queued"].includes(status);
  let sequence = -1;
  const textPart = (kind: "text" | "reasoning", seq: number) => {
    const id = `${kind}-${step}`;
    let part = parts.find((p) => p.id === id);
    if (!part) {
      part = { id, kind, step, sequence: seq, text: "", complete: false };
      const index =
        kind === "reasoning"
          ? parts.findIndex((p) => p.id === `text-${step}`)
          : -1;
      if (index >= 0) parts.splice(index, 0, part);
      else parts.push(part);
    }
    part.sequence = seq;
    return part;
  };
  for (const event of events) {
    sequence = Math.max(sequence, event.seq);
    const p = (event.payload ?? {}) as Record<string, unknown>;
    if (typeof p.step === "number") step = p.step;
    if (event.type === "run_started") {
      const listed = p.phases;
      if (Array.isArray(listed))
        phases.splice(
          0,
          phases.length,
          ...listed.filter((item): item is string => typeof item === "string"),
        );
    }
    if (event.type === "phase_started") {
      const id = typeof p.phase === "string" ? p.phase : undefined;
      if (id) {
        phase = id;
        if (!visited.includes(id)) visited.push(id);
        if (!phases.includes(id)) phases.push(id);
      }
    }
    if (event.type === "llm_call_started") textPart("text", event.seq);
    if (event.type === "llm_text_delta") {
      textPart("text", event.seq).text +=
        typeof p.text === "string" ? p.text : "";
      const reasoning = parts.find((part) => part.id === `reasoning-${step}`);
      if (reasoning) reasoning.complete = true;
    }
    if (event.type === "llm_reasoning_delta")
      textPart("reasoning", event.seq).text +=
        typeof p.text === "string" ? p.text : "";
    if (event.type === "llm_call_finished") {
      const text = textPart("text", event.seq);
      text.text = typeof p.text === "string" ? p.text : "";
      text.complete = true;
      const usage = p.usage as { reasoningTokens?: number } | undefined;
      // Zero is not evidence of reasoning: providers that report
      // `reasoning_tokens: 0` on every call (GLM tool turns) must not create
      // an empty "Provider reasoning · 0 tokens" block.
      const hasReasoningText =
        typeof p.reasoning === "string" && p.reasoning.trim() !== "";
      const reasoningTokens = usage?.reasoningTokens ?? 0;
      if (hasReasoningText || reasoningTokens > 0) {
        const reasoning = textPart("reasoning", event.seq);
        if (typeof p.reasoning === "string") reasoning.text = p.reasoning;
        reasoning.reasoningTokens = usage?.reasoningTokens;
      }
      const reasoning = parts.find((part) => part.id === `reasoning-${step}`);
      if (reasoning) reasoning.complete = true;
    }
    if (event.type === "tool_call" || event.type === "tool_result") {
      const name = typeof p.name === "string" ? p.name : "tool";
      const callId = typeof p.callId === "string" ? p.callId : undefined;
      let part =
        event.type === "tool_result"
          ? parts.find(
              (part) =>
                part.kind === "tool" &&
                part.step === step &&
                (callId
                  ? part.callId === callId
                  : part.name === name && !part.complete),
            )
          : undefined;
      if (!part) {
        const input =
          p.input && typeof p.input === "object"
            ? (p.input as Record<string, unknown>)
            : {};
        part = {
          id: callId ? `tool-${step}-${callId}` : `tool-${event.seq}`,
          callId,
          kind: "tool",
          name,
          verb: activityVerb(name, input, p.verb),
          step,
          sequence: event.seq,
          input,
          complete: false,
        };
        parts.push(part);
      }
      part.sequence = event.seq;
      if (typeof p.verb === "string")
        part.verb = activityVerb(name, part.input ?? {}, p.verb);
      if (event.type === "tool_result") {
        part.complete = true;
        part.ok = p.ok === true;
        part.content =
          typeof p.content === "string" ? p.content.slice(0, 4000) : "";
      }
    }
    if (event.type === "compacted") {
      // A visible handoff: the marker carries its fold counts and the summary
      // the agent now operates on. Same part on the live and the replay path.
      parts.push({
        id: `compaction-${event.seq}`,
        kind: "compaction",
        step,
        sequence: event.seq,
        removedMessages:
          typeof p.removedMessages === "number" ? p.removedMessages : undefined,
        keptMessages:
          typeof p.keptMessages === "number" ? p.keptMessages : undefined,
        summaryChars:
          typeof p.summaryChars === "number" ? p.summaryChars : undefined,
        summary: typeof p.summary === "string" ? p.summary : undefined,
        folding: typeof p.folding === "string" ? p.folding : undefined,
        complete: true,
      });
    }
    if (event.type === "run_finished") {
      finished = true;
      const summary = typeof p.summary === "string" ? p.summary.trim() : "";
      const lastText = parts
        .filter((p) => p.kind === "text" && p.text?.trim())
        .at(-1)
        ?.text?.trim();
      if (summary && summary !== lastText)
        parts.push({
          id: "final",
          kind: "text",
          step,
          sequence: event.seq,
          text: summary,
          complete: true,
        });
    }
  }
  if (finished) for (const part of parts) part.complete = true;
  return { parts, sequence, finished, phases, visited, phase };
}
