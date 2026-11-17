# Thread checkpoints

Anchor owns the **contract** for a durable thread log. The consumer owns the
database. A run is an attempt; the thread is the history.

The `checkpoints` module is the SDK-side half:

- the append-only `ThreadEvent` shape;
- the `CheckpointStore` interface the consumer implements;
- deterministic event keys so a retry is a duplicate, not a second write;
- the pure replay rules (`restorePlan`, `isStaleWrite`, `snapshotRun`,
  `restoreRun`).

No database, no network, and no version bump. The consumer decides what to store,
how long to keep it, and how to authenticate access.

## The model

```text
thread_events        append-only log, one row per event
thread_checkpoints   pointers: eventSeq + sandboxRef
```

A checkpoint is a **pointer**, not a copy:

```ts
interface CheckpointRef {
  id: string;
  eventSeq: number;        // replay events with seq <= eventSeq
  sandboxRef: string;      // commit/branch the workspace was at
  runId?: string;          // provenance only; never identity
  label?: string;
  reason:
    | "step_landed"
    | "run_recovered"
    | "plan_decided"
    | "manual"
    | "pre_restore";
  createdAt?: string;
}
```

The pair is the state: replay the log through `eventSeq`, and attach the
workspace at `sandboxRef`. The sandbox is not the source of truth; the log and
the git ref are.

## The store contract

```ts
interface CheckpointStore {
  append(threadId: string, events: ThreadEvent[]): Promise<AppendResult>;
  since(threadId: string, seq: number): Promise<ThreadEvent[]>;
  eventsThrough(threadId: string, seq: number): Promise<ThreadEvent[]>;
  putCheckpoint(threadId: string, checkpoint: CheckpointRef): Promise<void>;
  checkpoint(id: string): Promise<CheckpointRef | undefined>;
  latest(threadId: string): Promise<CheckpointRef | undefined>;
}
```

`append` is insert-only. It must be safe under concurrent writers of the same
key: the unique index on `(threadId, eventKey)` accepts one row, and the loser
reports the key in `duplicateKeys`. A duplicate is a success, not an error — the
caller reads the stored event and continues.

`putCheckpoint` is the same shape on `(threadId, eventSeq, sandboxRef)`.

`ThreadEvent` has `seq` and `at` assigned by the store on append. The writer
never supplies them; that keeps the log gapless and the clock honest.

## Deterministic event keys

`eventKeyFor(kind, ids)` derives the key from the work, not from the attempt, the
clock, or a UUID. A resumed run computes the same key for the same write, so the
store rejects the second one.

| Kind | Key |
| --- | --- |
| `message` | `message:<clientId>` |
| `plan` | `plan:<taskId>:<round>` |
| `gate` | `gate:<gateId>:<action>` |
| `step` | `step:<taskId>:<item>:<attempt>:<outcome>` |
| `checkpoint` | `checkpoint:<threadId>:<seq>` |
| `restore` | `restore:<threadId>:<checkpointId>:<n>` |
| `delivery` | `delivery:<threadId>:<kind>:<target>:<sha>` |
| `report` | `report:<taskId>:<kind>:<slug>` |

`toolCallEventKey({ tool, effectKey })` returns
`tool:<tool>:<effectKey>` for effectful calls. The consumer must supply
`tool.effect.key`; there is no fallback to the provider call id or a step
ordinal, because both are per attempt. A tool that cannot derive a key emits
none, and the operations store's `effect.reconcile` remains the safety net.

## Restore

```ts
const plan = restorePlan(events, { eventSeq: 42 });
// { events: [/* seq <= 42 */], head: 42 }
```

`restorePlan` only decides the replay basis. It does not rewrite the log. A
restore appends a `restore` event; the new branch is the prefix through the
checkpoint, and the abandoned future is ignored.

`isStaleWrite(event, restoreEvent)` is the stale-hand-back guard. It returns
true when either:

1. the write's `payload.runId` or `payload.attempt` names a producer the restore
   lists in `payload.supersedes`; or
2. the write was already logged at a seq strictly between the restore's
   replayed head and the restore event's own seq.

It fails open: an event with no provenance and no window match is never called
stale. Discarding a real write is worse than keeping a duplicate the unique
index would have rejected.

## Run snapshots

```ts
const snapshot = snapshotRun({
  eventSeq: 42,
  runId: "run_123",
  checkpointId: "cp_7",
  sandboxRef: "9c210ba",
  attempt: "attempt-1",
  phase: "build",
});

const { snapshot: same, events, head } = restoreRun(snapshot, log);
```

`snapshotRun` validates the one required fact: a non-negative integer log
offset. `runId` is provenance only. `restoreRun` returns the snapshot, the
replay prefix, and the head. The caller appends the `restore` event and
re-attaches the sandbox.

## Postgres sketch

```sql
create table thread_events (
  thread_id text not null,
  seq bigint not null,
  event_key text not null,
  kind text not null,
  actor text,
  payload jsonb not null,
  at timestamptz not null default now(),
  primary key (thread_id, seq),
  unique (thread_id, event_key)
);

create table thread_checkpoints (
  id text primary key,
  thread_id text not null,
  event_seq bigint not null,
  sandbox_ref text not null,
  run_id text,
  label text,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (thread_id, event_seq, sandbox_ref)
);
```

Append with `insert ... on conflict (thread_id, event_key) do nothing`, then
return the inserted rows and the keys that collided. Do not read-then-write.

## Limits

- The SDK does not ship a Postgres adapter.
- The consumer owns retention, access control, and the janitor.
- The log is a history, not a mutable task board. The task contract remains in
  `ProgressLedger`.
- `eventKey` is for effectful writes; read-only calls do not carry one.
- A checkpoint is a git commit plus a log offset. It does not replace the
  sandbox's own lifecycle or retention policy.

## Tests

- `tests/unit/checkpoints.test.ts` covers key derivation, the three-checkpoint
  replay, stale writes, the store contract, and the run round-trip.
