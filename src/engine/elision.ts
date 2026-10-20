/**
 * Assistant-text elision — the history boundary for the model's own words.
 *
 * Tool output has had a boundary since the spill work: `truncate.ts` keeps a
 * head and a tail, and saves the full text so the clipped middle stays
 * addressable. The assistant's own replies had none, so one runaway turn
 * (108,578 chars in the GLM run behind #75) was replayed verbatim on every
 * later call: the model re-reading its own essay, and paying for it each
 * time. At ~27k tokens a replay across ~29 remaining calls, that single turn
 * supplied roughly half the run's billed tokens.
 *
 * Same shape here, with three differences:
 *
 *   1. It bounds the MODEL'S VIEW, not the stored transcript. The loop keeps
 *      `messages` intact (persistence, replay, audit) and sends this
 *      projection to the provider.
 *   2. A capped turn (finishReason "length") keeps only its head. Its tail is
 *      mid-token by construction, so the intent at the start is the only
 *      signal worth replaying.
 *   3. The full reply is spilled to scratch and pointed at, so the omission is
 *      recoverable rather than final (#77).
 */
import { shq, type Sandbox } from "../sandbox/types.js";

/** Replay budget for one assistant reply, in chars (≈ 5k tokens at 4 chars/token). */
export const DEFAULT_MAX_ASSISTANT_CHARS = 20_000;

/**
 * A capped turn is incomplete: its tail stops mid-token, so only its head is
 * worth replaying. This is the dial for that tighter budget — deliberately
 * below `DEFAULT_MAX_ASSISTANT_CHARS`. 12k CHARS, not tokens: about 3k tokens,
 * a fraction of a capped turn, so a chopped essay is not replayed in full.
 */
export const DEFAULT_TRUNCATED_REPLY_CHARS = 12_000;

/** Absurd payloads are not worth a write; elide without a pointer. */
const SPILL_MAX_CHARS = 4_000_000;

export interface ElidedReply {
  text: string;
  omittedChars: number;
}

export interface ElideOptions {
  /** Keep a tail. False for a capped turn, whose tail is mid-token. */
  tail?: boolean;
  /** Appended to the marker — e.g. where the full reply was spilled. */
  note?: string;
}

/**
 * Head + marker + tail, sized to `budget`. Under budget → the text unchanged.
 * The split mirrors tool output (60/40): openings carry intent, endings carry
 * the conclusion, and the middle of a ramble is repetition.
 */
export function elideReply(
  text: string,
  budget: number,
  opts: ElideOptions = {},
): ElidedReply {
  if (text.length <= budget) return { text, omittedChars: 0 };
  const keepTail = opts.tail ?? true;
  const headChars = keepTail ? Math.floor(budget * 0.6) : budget;
  const tailChars = keepTail ? budget - headChars : 0;
  const omittedChars = text.length - headChars - tailChars;
  const marker =
    `\n[... ${omittedChars} chars of this reply were omitted from the replayed history` +
    `${opts.note ? `; ${opts.note}` : ""} ...]\n`;
  return {
    text:
      text.slice(0, headChars) +
      marker +
      (tailChars > 0 ? text.slice(text.length - tailChars) : ""),
    omittedChars,
  };
}

let spillSeq = 0;

/**
 * Best-effort: save the full reply to the sandbox's scratch dir and return its
 * path, so an elided middle can be read back. Any failure returns undefined
 * and leaves the caller with plain elision — never breaks the turn.
 */
export async function spillReply(
  sandbox: Sandbox | undefined,
  text: string,
): Promise<string | undefined> {
  if (!sandbox || text.length > SPILL_MAX_CHARS) return undefined;
  const file = `${sandbox.scratch}/out/reply-${Date.now().toString(36)}${(spillSeq++).toString(36)}.txt`;
  const dir = file.slice(0, file.lastIndexOf("/"));
  try {
    const b64 = Buffer.from(text, "utf8").toString("base64");
    const write = await sandbox.exec(
      `mkdir -p ${shq(dir)} && printf %s ${shq(b64)} | base64 -d > ${shq(file)}`,
      { timeoutSecs: 120 },
    );
    if (write.exitCode !== 0) return undefined;
  } catch {
    return undefined;
  }
  return file;
}
