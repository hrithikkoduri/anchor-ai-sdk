/**
 * Thread checkpoints — the SDK-side contract for a durable, append-only thread
 * log plus the pure recovery rules that run on top of it.
 *
 * Anchor does not own a database. The consumer's Postgres is the truth: it
 * holds `thread_events` (the log), `thread_checkpoints` (the pointers) and the
 * unique index that makes every write idempotent. This module is the shape and
 * the policy — the `CheckpointStore` interface the consumer implements, the
 * deterministic key derivation that the unique index enforces, and the pure
 * functions a restore/resume uses to decide what to replay and what to ignore.
 *
 * The governing principle (design note `THREAD-CHECKPOINTS.md`): **the run is
 * an attempt; the thread is the history.** Every durable write carries a key
 * derived from the *work* — never from the attempt, the clock, or a UUID — so
 * a restore, a resume, or a retried delivery can never apply the same write
 * twice. `runId` is provenance only.
 */
import type { Checkpoint } from "./sandbox/types.js";

/**
 * One entry in the thread log. Kinds are open strings (a consumer may add its
 * own); the canonical set is `CANONICAL_THREAD_EVENT_KINDS`.
 *
 * `seq` and `at` are assigned by the store on append: the writer supplies
 * neither, which is what keeps the log gapless and the clock honest. A
 * replayed/abandoned event read back from the store carries them.
 */
export interface ThreadEvent {
  /** Per-thread, gapless position. Assigned by the store on append. */
  seq?: number;
  /** Open string; see `CANONICAL_THREAD_EVENT_KINDS`. */
  kind: string;
  /** The idempotency key for this write. Unique per (threadId, eventKey). */
  eventKey: string;
  /** "user:<id>" | "captain" | "builder-1" | "code" | … */
  actor?: string;
  /** Semantic payload; never a secret value. */
  payload: unknown;
  /** ISO timestamp, assigned by the store on append. */
  at?: string;
}

/**
 * The kinds the design note names. Deliberately an open `string` on
 * `ThreadEvent.kind`: a new event must never require an SDK release, and an
 * unknown kind is data, not a parse error. The list is documentation + a
 * shared name for tests and consumers that want to close their own union.
 */
export const CANONICAL_THREAD_EVENT_KINDS = [
  "message",
  "plan_proposed",
  "plan_revised",
  "gate_decided",
  "step_started",
  "step_finished",
  "verdict",
  "tool_call",
  "tool_result",
  "delivery",
  "report",
  "checkpoint",
  "restore",
  "redaction",
] as const;

/** Why a checkpoint was taken. */
export type CheckpointReason =
  | "step_landed"
  | "run_recovered"
  | "plan_decided"
  | "manual"
  | "pre_restore";

/**
 * A pointer, not a copy: the sandbox ref plus the log offset that together
 * define a restorable thread state. `eventSeq` is the whole point — state is
 * "replay <= eventSeq", and the sandbox ref is the workspace that went with it.
 */
export interface CheckpointRef {
  id: string;
  /** State is defined as "replay events with seq <= this". */
  eventSeq: number;
  /** Commit/branch the workspace was checkpointed at. */
  sandboxRef: string;
  /** The attempt in flight when it was taken — provenance, never identity. */
  runId?: string;
  label?: string;
  reason: CheckpointReason;
  createdAt?: string;
}

/** What an append accepted, and which keys the store already had. */
export interface AppendResult {
  /** The events actually inserted, in append order, with seq/at assigned. */
  appended: ThreadEvent[];
  /** eventKeys that already existed; their events were NOT inserted. */
  duplicateKeys: string[];
}

/**
 * The append-only thread log and its checkpoint pointers — the store a
 * consumer implements against Postgres, and any consumer implements for tests.
 *
 * `append` MUST be implementable with a unique index on
 * `(threadId, eventKey)` and must never read-then-write: two writers racing
 * the same key produce one row, and the loser gets the key back in
 * `duplicateKeys` (a no-op is a success, not an error — the caller reads the
 * stored event and continues). `putCheckpoint` is the same shape on
 * `(threadId, eventSeq, sandboxRef)`.
 */
export interface CheckpointStore {
  /**
   * Append events to a thread's log. Insert-only: an event whose `eventKey`
   * already exists is reported in `duplicateKeys` and omitted from `appended`.
   * Must be safe under concurrent writers of the same key.
   */
  append(threadId: string, events: ThreadEvent[]): Promise<AppendResult>;
  /** Events strictly after `seq`, oldest first. */
  since(threadId: string, seq: number): Promise<ThreadEvent[]>;
  /** Events at or before `seq`, oldest first — the replay basis for a restore. */
  eventsThrough(threadId: string, seq: number): Promise<ThreadEvent[]>;
  /** Record a checkpoint pointer. A duplicate (thread, seq, ref) is a no-op. */
  putCheckpoint(threadId: string, checkpoint: CheckpointRef): Promise<void>;
  /** One checkpoint by id, or undefined. */
  checkpoint(id: string): Promise<CheckpointRef | undefined>;
  /** The thread's newest checkpoint (highest eventSeq), or undefined. */
  latest(threadId: string): Promise<CheckpointRef | undefined>;
}

// ---------------------------------------------------------------------------
// Deterministic key derivation
// ---------------------------------------------------------------------------

/**
 * The write categories the design note keys. This is the *key* kind — the
 * prefix — not necessarily the event's `kind` field (a `plan` key may belong
 * to a `plan_proposed` event).
 */
export type EventKeyKind =
  | "message"
  | "plan"
  | "gate"
  | "step"
  | "checkpoint"
  | "restore"
  | "delivery"
  | "report";

/**
 * The id parts `eventKeyFor` reads. Which are required depends on `kind`; see
 * the table in the design note. `runId` is deliberately absent: a run id must
 * never reach the write path.
 */
export interface EventKeyIds {
  /** message */
  clientId?: string;
  /** plan, step, report */
  taskId?: string;
  /** plan */
  round?: string | number;
  /** gate */
  gateId?: string;
  /** gate */
  action?: string;
  /** step */
  item?: string;
  /** step */
  attempt?: string | number;
  /** step */
  outcome?: string;
  /** checkpoint, restore, delivery */
  threadId?: string;
  /** checkpoint */
  seq?: string | number;
  /** restore */
  checkpointId?: string;
  /** restore */
  n?: string | number;
  /** delivery, report */
  kind?: string;
  /** delivery */
  target?: string;
  /** delivery */
  sha?: string;
  /** report */
  slug?: string;
}

/** Prefix + required id parts for each key kind, in output order. */
const EVENT_KEY_PARTS: Record<
  EventKeyKind,
  { prefix: string; parts: readonly (keyof EventKeyIds)[] }
> = {
  message: { prefix: "message", parts: ["clientId"] },
  plan: { prefix: "plan", parts: ["taskId", "round"] },
  gate: { prefix: "gate", parts: ["gateId", "action"] },
  step: { prefix: "step", parts: ["taskId", "item", "attempt", "outcome"] },
  checkpoint: { prefix: "checkpoint", parts: ["threadId", "seq"] },
  restore: { prefix: "restore", parts: ["threadId", "checkpointId", "n"] },
  delivery: {
    prefix: "delivery",
    parts: ["threadId", "kind", "target", "sha"],
  },
  report: { prefix: "report", parts: ["taskId", "kind", "slug"] },
};

const nonEmpty = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
};

/**
 * Derive the idempotency key for a durable write, exactly as the design note
 * tabulates:
 *
 * ```
 * message:<clientId>
 * plan:<taskId>:<round>
 * gate:<gateId>:<action>
 * step:<taskId>:<item>:<attempt>:<outcome>
 * checkpoint:<threadId>:<seq>
 * restore:<threadId>:<checkpointId>:<n>
 * delivery:<threadId>:<kind>:<target>:<sha>
 * report:<taskId>:<kind>:<slug>
 * ```
 *
 * Deterministic and derived from the work — a resumed run or a replay computes
 * the same key for the same write, so the store's unique index discards the
 * second one. Throws on an unknown kind or a missing/blank id part rather than
 * minting an empty key that would collide with every other empty key.
 */
export function eventKeyFor(
  kind: EventKeyKind | (string & {}),
  ids: EventKeyIds,
): string {
  const spec = EVENT_KEY_PARTS[kind as EventKeyKind];
  if (!spec)
    throw new Error(
      `eventKeyFor: unknown event key kind "${kind}" — expected one of ${Object.keys(
        EVENT_KEY_PARTS,
      ).join(", ")}`,
    );
  const values = spec.parts.map((part) => {
    const text = nonEmpty(ids[part]);
    if (text === undefined)
      throw new Error(
        `eventKeyFor: kind "${kind}" requires id part "${part}" (got ${
          ids[part] === undefined ? "undefined" : JSON.stringify(ids[part])
        })`,
      );
    return text;
  });
  return [spec.prefix, ...values].join(":");
}

/**
 * The journal key for a side-effecting tool call.
 *
 * Only a key the CONSUMER derives from the work is accepted: `tool.effect.key`,
 * e.g. `delivery:<threadId>:<kind>:<target>` or `comment:<repo>:<issue>:<hash>`.
 * There is deliberately no fallback to the provider's call id or to a step
 * ordinal — both are per attempt, so a resumed run would mint a different key
 * and the duplicate would never be recognised. A tool that cannot derive a key
 * emits none, and crash safety falls back to the operations store's own
 * identity (a fresh operation id plus `effect.reconcile`, which refuses to
 * replay when it cannot tell whether the write landed).
 */
export function toolCallEventKey(args: {
  tool: string;
  /** `tool.effect.key(input)`; the only accepted identity. */
  effectKey?: string;
}): string | undefined {
  const tool = nonEmpty(args.tool);
  if (tool === undefined) return undefined;
  const effectKey = nonEmpty(args.effectKey);
  if (effectKey === undefined) return undefined;
  return `tool:${tool}:${effectKey}`;
}

// ---------------------------------------------------------------------------
// Restore — replay a branch, ignore the abandoned future
// ---------------------------------------------------------------------------

/** The branch to replay: events through the checkpoint, and the head seq. */
export interface RestorePlan {
  /** Every event with `seq <= checkpoint.eventSeq`, oldest first. */
  events: ThreadEvent[];
  /** The log offset the branch replays through (the checkpoint's eventSeq). */
  head: number;
}

/**
 * The pure replay basis for a restore: the events a resumed state is rebuilt
 * from. Nothing is rewritten — a restore appends; this just says which prefix
 * of the log is the branch being resumed. Events with no `seq` (never stored)
 * are not replayable and are dropped.
 */
export function restorePlan(
  events: ThreadEvent[],
  checkpoint: Pick<CheckpointRef, "eventSeq">,
): RestorePlan {
  const replayed = events
    .filter(
      (event): event is ThreadEvent & { seq: number } =>
        typeof event.seq === "number" && event.seq <= checkpoint.eventSeq,
    )
    .sort((a, b) => a.seq - b.seq);
  return { events: replayed, head: checkpoint.eventSeq };
}

/** A write's producer, read from its payload (`runId` then `attempt`). */
function producerIdOf(event: ThreadEvent): string | undefined {
  if (!event.payload || typeof event.payload !== "object") return undefined;
  const payload = event.payload as Record<string, unknown>;
  return nonEmpty(payload.runId) ?? nonEmpty(payload.attempt);
}

/** The producers a restore event names as abandoned, from its payload. */
function supersededIdsOf(restoreEvent: ThreadEvent): Set<string> {
  const superseded = new Set<string>();
  if (!restoreEvent.payload || typeof restoreEvent.payload !== "object")
    return superseded;
  const payload = restoreEvent.payload as Record<string, unknown>;
  const declared = payload.supersedes;
  const values = Array.isArray(declared) ? declared : [declared];
  for (const value of values) {
    const text = nonEmpty(value);
    if (text !== undefined) superseded.add(text);
  }
  return superseded;
}

/** The seq the restore replays through, from its payload. */
function restoredHeadOf(restoreEvent: ThreadEvent): number | undefined {
  if (!restoreEvent.payload || typeof restoreEvent.payload !== "object")
    return undefined;
  const payload = restoreEvent.payload as Record<string, unknown>;
  const head = payload.eventSeq ?? payload.fromEventSeq;
  return typeof head === "number" && Number.isFinite(head) ? head : undefined;
}

/**
 * The stale-hand-back guard. After a restore, an append from a run/attempt
 * that predates the restore is the abandoned future and must be ignored — the
 * same way a superseded run's hand-back already is today.
 *
 * Two independent signals, either one true:
 *
 *   1. Provenance. The write's `payload.runId` (or `payload.attempt`) names a
 *      producer the restore lists in `payload.supersedes`. This catches a
 *      hand-back that arrives AFTER the restore with a fresh seq.
 *   2. Window. The write was already logged at a seq strictly between the
 *      restore's replayed head (`payload.eventSeq`) and the restore event's own
 *      seq — the branch the restore abandoned. New-branch writes land after the
 *      restore event, so they are never caught here.
 *
 * Fails OPEN: an event with no provenance and no window match is never called
 * stale, because discarding a real write is worse than keeping a duplicate the
 * unique index would have rejected anyway.
 */
export function isStaleWrite(
  event: ThreadEvent,
  restoreEvent: ThreadEvent,
): boolean {
  if (restoreEvent.kind !== "restore") return false;
  const producer = producerIdOf(event);
  if (producer !== undefined && supersededIdsOf(restoreEvent).has(producer))
    return true;
  const restoredHead = restoredHeadOf(restoreEvent);
  return (
    restoredHead !== undefined &&
    typeof event.seq === "number" &&
    typeof restoreEvent.seq === "number" &&
    event.seq > restoredHead &&
    event.seq < restoreEvent.seq
  );
}

// ---------------------------------------------------------------------------
// The run half of a checkpoint
// ---------------------------------------------------------------------------

/**
 * The run half of a checkpoint: which attempt a resumed run continues, and
 * from which checkpoint/log offset. The thread half is the log; this is the
 * shape that lets a resume say "same work, continued" instead of guessing from
 * the latest mutable `runs` row.
 */
export interface RunSnapshot {
  /** Opaque consumer run id — provenance, never a write key. */
  runId?: string;
  /** The thread log offset this run's model context was built through. */
  eventSeq: number;
  /** The checkpoint this run continues from, when it is a resume. */
  checkpointId?: string;
  /** The workspace ref (commit/branch) the run was at, if known. */
  sandboxRef?: string;
  /** Stable attempt identity that survives a resume. */
  attempt?: string;
  /** Phase the resumed run should start at, if the engine carries one. */
  phase?: string;
  /** How the run ended, when this was taken at its end. */
  reason?: string;
}

/**
 * Build a `RunSnapshot` from a run's coordinates. Pure: it validates the one
 * required fact (a non-negative integer log offset) and copies the rest. Keep
 * it additive — it never mutates the run or the thread.
 */
export function snapshotRun(args: {
  eventSeq: number;
  runId?: string;
  checkpointId?: string;
  sandboxRef?: string;
  attempt?: string;
  phase?: string;
  reason?: string;
}): RunSnapshot {
  if (!Number.isInteger(args.eventSeq) || args.eventSeq < 0)
    throw new Error(
      `snapshotRun: eventSeq must be a non-negative integer (got ${args.eventSeq})`,
    );
  return {
    eventSeq: args.eventSeq,
    ...(args.runId !== undefined ? { runId: args.runId } : {}),
    ...(args.checkpointId !== undefined
      ? { checkpointId: args.checkpointId }
      : {}),
    ...(args.sandboxRef !== undefined ? { sandboxRef: args.sandboxRef } : {}),
    ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
    ...(args.phase !== undefined ? { phase: args.phase } : {}),
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
  };
}

/** What restoring a run yields: the snapshot, the replay prefix, the head. */
export interface RestoredRun {
  /** The snapshot carried forward: which attempt continues, from where. */
  snapshot: RunSnapshot;
  /** The events to replay (seq <= snapshot.eventSeq), oldest first. */
  events: ThreadEvent[];
  /** The log offset the run resumes from. */
  head: number;
}

/**
 * Restore a run from a snapshot: the exact attempt it continues
 * (`snapshot.attempt`), the checkpoint it continues from
 * (`snapshot.checkpointId`) and the log prefix it replays. Pure — the caller
 * appends the `restore` event and re-attaches the sandbox; this only decides
 * the replay basis.
 */
export function restoreRun(
  snapshot: RunSnapshot,
  events: ThreadEvent[],
): RestoredRun {
  const plan = restorePlan(events, { eventSeq: snapshot.eventSeq });
  return { snapshot: { ...snapshot }, events: plan.events, head: plan.head };
}

/**
 * Down-convert a sandbox `Checkpoint` (a git commit) into the pointer half of
 * a `CheckpointRef`. The caller supplies the log offset and reason; the sandbox
 * ref comes from the commit. Additive: existing snapshot code is untouched.
 */
export function toCheckpointRef(args: {
  id: string;
  eventSeq: number;
  checkpoint: Pick<Checkpoint, "sha">;
  reason: CheckpointReason;
  runId?: string;
  label?: string;
  createdAt?: string;
}): CheckpointRef {
  return {
    id: args.id,
    eventSeq: args.eventSeq,
    sandboxRef: args.checkpoint.sha,
    reason: args.reason,
    ...(args.runId !== undefined ? { runId: args.runId } : {}),
    ...(args.label !== undefined ? { label: args.label } : {}),
    ...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
  };
}
