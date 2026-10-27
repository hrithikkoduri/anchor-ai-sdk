/**
 * Guardrail mechanics: the shared shape of a course-correction, the messages
 * each guardrail puts in front of the model, and the repetition tracker.
 *
 * POLICY STAYS IN THE LOOP. Which correction fires, when it gives up, and how
 * many times it may repeat are decisions about a run, not about a string. This
 * module owns the parts that are identical across all of them: an advisory
 * event, one runtime-only message, a persistence boundary, and a prose
 * checkpoint marker.
 */
import type { LLMMessage, LLMUsage } from "../llm/types.js";
import type { AgentEvent, EventSink } from "./events.js";

export type AdvisoryKind = Extract<AgentEvent, { type: "advisory" }>["kind"];

export interface CourseCorrection {
  kind: AdvisoryKind;
  detail: string;
  content: string;
}

/**
 * The shared mechanic. Callers own the policy; this only records the advisory,
 * puts the message in front of the model, and persists the turn boundary. A
 * prose reply that follows any of these is a checkpoint, not an answer, so
 * every call marks it.
 */
export function createCourseCorrect(args: {
  emit: EventSink;
  messages: LLMMessage[];
  persist: () => Promise<void>;
  markProseCheck: () => void;
}): (correction: CourseCorrection) => Promise<void> {
  return async (correction) => {
    args.markProseCheck();
    args.emit({
      type: "advisory",
      kind: correction.kind,
      detail: correction.detail,
    });
    args.messages.push({
      role: "user",
      origin: "engine",
      content: correction.content,
    });
    await args.persist();
  };
}

/** Repetition window: `limit` identical signatures in a row is a loop. */
export class RepeatTracker {
  private readonly seen: string[] = [];

  constructor(private readonly limit: number | false) {}

  /** Record one call; true when it closes an all-identical window. */
  record(signature: string): boolean {
    if (this.limit === false) return false;
    this.seen.push(signature);
    if (this.seen.length > this.limit) this.seen.shift();
    return (
      this.seen.length === this.limit &&
      this.seen.every((value) => value === signature)
    );
  }

  /** Start clean after a correction. */
  reset(): void {
    this.seen.length = 0;
  }
}

/**
 * Output the model actually SHOWED. Providers report reasoning inside
 * completionTokens; hidden thinking must never count as verbosity.
 */
export function visibleOutputTokens(usage: LLMUsage): number {
  return Math.max(0, usage.completionTokens - (usage.reasoningTokens ?? 0));
}

/** "…a different call, or `finish`…" */
const finishTaskHint = (hasFinish: boolean): string =>
  hasFinish ? ", or `finish` if the work is already done." : ".";

/** "…a tool call, or call `finish`…" */
const callFinishHint = (hasFinish: boolean): string =>
  hasFinish ? ", or call `finish` if the work is already done." : ".";

export function silentNudge(limit: number): string {
  return (
    `You have taken ${limit} tool steps without writing anything visible — ` +
    `the user cannot see your reasoning. State in one line what you found and what remains, ` +
    `then keep moving in the same turn with your next tool call: ` +
    `visible notes survive context folding, silent reasoning does not.`
  );
}

export function verboseNudge(tokens: number): string {
  return (
    `Your last turn produced ${tokens} tokens of visible output without moving the work forward. ` +
    `Stop deliberating in prose. State what you know in one line, then take the next concrete step — ` +
    `a command or an edit. If you are stuck, say what you tried in one line and try a different approach; ` +
    `do not re-derive what you have already established. Do not end this turn without a tool call.`
  );
}

export function cappedReplyNudge(limit: number, hasFinish: boolean): string {
  return (
    `Your last reply was cut off by the ${limit}-token output cap and had no tool call, so it was not accepted. ` +
    `Do not rewrite it. Continue the work — your next turn must include a tool call.` +
    (hasFinish ? " If the work is already complete, call `finish`." : "")
  );
}

export function proseCheckpoint(): string {
  return (
    "You wrote a reply but did not call `finish`. If the work is complete, " +
    "call `finish` with your outcome. If it is not complete, continue " +
    "working — your next turn must include a tool call. If you are done " +
    "and have nothing to add, repeat your reply and the run will end."
  );
}

export function repeatedCallNudge(limit: number, hasFinish: boolean): string {
  return (
    `This tool call was byte-for-byte the same as the previous ${limit - 1}, so it was not executed. ` +
    `The last one already ran, and its result is in the conversation above. Running the same arguments again cannot produce a new result. ` +
    `Use that result. If it was an edit that changed nothing, the text you tried to replace is not in the file — read the file and copy the exact text. ` +
    `Your next action must be a different call` +
    finishTaskHint(hasFinish)
  );
}

/**
 * The delegated child's soft-cap directive. User-facing prose the child's
 * model reads: short, specific, and firm about handing back. Delivered as an
 * ordinary runtime message in the child's own stream — never a tool, never a
 * user turn, so it cannot be mistaken for work.
 */
export function wrapUpNudge(stepsLeft: number, reason: string): string {
  const left = stepsLeft > 0 ? `${stepsLeft} step${stepsLeft === 1 ? "" : "s"}` : "no";
  return (
    `Wrap-up directive from your leader: you have ${left} left of your budget (${reason}). ` +
    `Stop exploring. Answer what you can now, list what is unfinished, and hand back — ` +
    `a partial result stated clearly is worth more than a complete one you never deliver.`
  );
}

export function emptyTurnNudge(hasFinish: boolean): string {
  return (
    "Your last turn had no visible text and no tool call, so it was not accepted. " +
    "A reasoning-only turn does not count. Your next turn must include a tool call" +
    callFinishHint(hasFinish)
  );
}
