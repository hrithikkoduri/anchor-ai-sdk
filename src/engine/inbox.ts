/**
 * The thread inbox — messages that arrive while a run is working.
 *
 * A run owns one task at a time, and the chat protocol forbids splicing a new
 * user turn into the middle of an assistant/tool exchange. So an arriving
 * message has three honest destinations:
 *
 *   - `queue`     — leave the running run alone. The message becomes (part of)
 *                   the next run's task.
 *   - `interject` — end the running run at its next turn boundary, then start
 *                   the next run with this message.
 *   - `steer`     — deliver into the SAME run at its next turn boundary, as an
 *                   engine user message. It never ends the run: use it to
 *                   nudge a worker (a time notice, "speed up"), not to correct
 *                   or stop it.
 *
 * When to use which: nudge a running worker — `steer`; correct or stop it —
 * `interject`; hand it more work — `queue`.
 *
 * The store is the consumer's: a database in production, `MemoryInboxStore`
 * for tests and single-process apps. The package owns *when* to look and what
 * a claim means; it never owns the queue itself (the same split as
 * `ThreadStore`).
 *
 * Ordering is part of the contract, not a hint: a claim returns pending
 * interjections first (newest first — the latest correction supersedes the
 * older ones), then queued messages oldest-first. A store that cannot express
 * that ordering cannot implement this interface. Pending `steer` messages join
 * the queued ones in that second group, oldest-first: a steer the run never
 * reached (it arrived after the last turn boundary, or an interjection ended
 * the run first) is NOT lost — it rides the next run's batch.
 */
import type { ImageAttachment, LLMMessage, LLMUsage } from "../llm/types.js";
import type { FinishReason } from "./types.js";

export type InboxDelivery = "queue" | "interject" | "steer";

/** One message waiting for (or claimed by) a run. */
export interface InboxMessage {
  /**
   * Stable, caller-assigned identity: a webhook delivery id, a chat message id.
   * Pushing the same id twice is a duplicate, never a second delivery.
   */
  id: string;
  /** The work-stream this message belongs to — usually the thread id. */
  channel: string;
  /** What the model should act on. Becomes part of the next run's task. */
  text: string;
  /** Optional application context for the run this message starts. */
  context?: string;
  /** Image references for the run this message starts. */
  images?: ImageAttachment[];
  delivery: InboxDelivery;
}

/** One finished run of a chain, as reported on `AgentResult.runs`. */
export interface RunSummary {
  reason: FinishReason;
  ok: boolean;
  steps: number;
  phase?: string;
  summary?: string;
  usage: LLMUsage;
}

/**
 * Where a consumer keeps its pending messages. Every method is async so a
 * database implementation needs no wrapper.
 */
export interface InboxStore {
  /** Queue one message. Duplicates are reported, not thrown. */
  push(message: InboxMessage): Promise<"queued" | "duplicate">;
  /**
   * Is anything waiting at all? Optional: when a run is about to finish with a
   * background job still running, the engine asks this before waiting for the
   * job. A pending message means the chain will continue anyway, so the job can
   * be carried into the next run instead of delaying this one.
   */
  hasPending?(channel: string): Promise<boolean>;
  /**
   * Is there a pending interjection for this channel? Called at every turn
   * boundary of a run, so it must be cheap (an indexed existence check, not a
   * full scan of the inbox). Only `interject` rows count: `steer` and `queue`
   * rows must be IGNORED, or a nudge would end the run it was meant to speed up.
   */
  hasInterject(channel: string): Promise<boolean>;
  /**
   * Atomically claim the pending `steer` messages of the channel, oldest
   * first, and nothing else (never an `interject` or `queue` row). Same
   * contract as `claimAll`: a claimed row is invisible to other claims until
   * `release`d, and `complete` retires it for good.
   *
   * Optional. The engine calls it at every turn boundary of a running chain
   * (after the interjection probe, which wins), so it must be cheap: one
   * indexed query. When a store does not implement it, a `steer` message is
   * simply treated as `queue` — it waits for the run to end and rides the next
   * run's `claimAll` batch.
   */
  claimSteers?(channel: string): Promise<InboxMessage[]>;
  /**
   * Atomically claim every pending message for the channel: interjections
   * first (newest first), then queued and steer messages together
   * (oldest first). A `steer` still pending at this point (it arrived after
   * the last turn boundary, or an interjection ended the run first) is part of
   * the batch — it is never lost. A claimed message must not be returned by
   * another claim until it is released — in a database that means
   * `FOR UPDATE SKIP LOCKED` (plus a lease timeout, so a crashed worker's
   * claim is recoverable).
   */
  claimAll(channel: string): Promise<InboxMessage[]>;
  /** The claimed batch was delivered into a run. Never return it again. */
  complete(ids: string[]): Promise<void>;
  /** The run died before using the batch. Make it claimable again. */
  release(ids: string[]): Promise<void>;
}

/** In-memory inbox: tests, demos, and single-process consumers. */
export class MemoryInboxStore implements InboxStore {
  private seq = 0;
  private readonly rows = new Map<
    string,
    { message: InboxMessage; status: "pending" | "claimed" | "consumed"; seq: number }
  >();

  async push(message: InboxMessage): Promise<"queued" | "duplicate"> {
    if (!message.id) throw new Error("anchor: inbox message needs an id");
    if (!message.channel)
      throw new Error("anchor: inbox message needs a channel");
    if (message.text.trim() === "")
      throw new Error("anchor: inbox message needs text");
    const key = `${message.channel}\u0000${message.id}`;
    const existing = this.rows.get(key);
    // A consumed id may be pushed again on purpose (a new event reusing a
    // stable id is the caller's bug, but treating it as a duplicate keeps
    // delivery at-most-once instead of silently re-running work).
    if (existing) return "duplicate";
    this.rows.set(key, {
      message: { ...message },
      status: "pending",
      seq: this.seq++,
    });
    return "queued";
  }

  async hasPending(channel: string): Promise<boolean> {
    return this.pendingCount(channel) > 0;
  }

  async hasInterject(channel: string): Promise<boolean> {
    for (const row of this.rows.values())
      if (
        row.status === "pending" &&
        row.message.channel === channel &&
        row.message.delivery === "interject"
      )
        return true;
    return false;
  }

  async claimSteers(channel: string): Promise<InboxMessage[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.status === "pending" &&
          row.message.channel === channel &&
          row.message.delivery === "steer",
      )
      .sort((a, b) => a.seq - b.seq)
      .map((row) => {
        row.status = "claimed";
        return { ...row.message };
      });
  }

  async claimAll(channel: string): Promise<InboxMessage[]> {
    const pending = [...this.rows.values()].filter(
      (row) => row.status === "pending" && row.message.channel === channel,
    );
    if (pending.length === 0) return [];
    const interjects = pending
      .filter((row) => row.message.delivery === "interject")
      .sort((a, b) => b.seq - a.seq);
    const queued = pending
      .filter((row) => row.message.delivery !== "interject")
      .sort((a, b) => a.seq - b.seq);
    const batch = [...interjects, ...queued].map((row) => {
      row.status = "claimed";
      return { ...row.message };
    });
    return batch;
  }

  async complete(ids: string[]): Promise<void> {
    this.setStatus(ids, "consumed");
  }

  async release(ids: string[]): Promise<void> {
    this.setStatus(ids, "pending");
  }

  /** Diagnostic: how many messages are still waiting on a channel. */
  pendingCount(channel: string): number {
    let count = 0;
    for (const row of this.rows.values())
      if (row.status === "pending" && row.message.channel === channel) count++;
    return count;
  }

  /** Only a claimed row moves; completion is final, and release is a retry. */
  private setStatus(ids: string[], status: "pending" | "consumed"): void {
    for (const row of this.rows.values()) {
      if (row.status !== "claimed" || !ids.includes(row.message.id)) continue;
      row.status = status;
    }
  }
}

/**
 * Turn a claimed batch into the next run's input. One message per inbox row:
 * a coalesced batch stays a sequence of user turns rather than becoming a
 * synthetic single blob. Context is application metadata, so it is joined
 * separately and never persisted as a message.
 */
export function renderInboxTurn(messages: InboxMessage[]): {
  messages: LLMMessage[];
  context?: string;
} {
  const context = messages
    .map((message) => message.context)
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join("\n\n");
  return {
    messages: messages.map((message) => ({
      role: "user" as const,
      content: message.text,
      ...(message.images?.length ? { images: message.images } : {}),
    })),
    ...(context === "" ? {} : { context }),
  };
}
