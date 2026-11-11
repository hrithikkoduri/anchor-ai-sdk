# Inbox: messages while a run is working

The inbox is the consumer-owned queue for messages that arrive while a run is
already in progress. The SDK owns **when** to look and what a claim means; the
consumer owns the store.

## Three deliveries

| Delivery | What happens | Use it to |
| --- | --- | --- |
| `steer` | Delivered into the **same run** at its next turn boundary, as an engine user message. The run is never ended. | Nudge a running worker: "speed up", "2 minutes left". |
| `interject` | Ends the running run at its next turn boundary; the chain continues with the message. | Correct or stop it. |
| `queue` | Leaves the running run alone; the message becomes the next run's task. | Hand it more work. |

A message is a stable row:

```ts
interface InboxMessage {
  id: string;          // caller-assigned; duplicates are rejected
  channel: string;     // usually the thread id
  text: string;
  context?: string;
  images?: ImageAttachment[];
  delivery: "queue" | "interject" | "steer";
}
```

## Ordering

Ordering is part of the contract, not a hint:

- A `claimAll` returns pending **interjections first**, newest first. The latest
  correction supersedes the older ones.
- Then it returns queued and `steer` messages together, oldest first.
- A `steer` that arrives after the last turn boundary, or after an interjection
  ended the run, is not lost. It rides the next run's `claimAll` batch.

A store that cannot express that ordering cannot implement this interface.

## The store contract

```ts
interface InboxStore {
  push(message: InboxMessage): Promise<"queued" | "duplicate">;
  hasPending?(channel: string): Promise<boolean>;
  hasInterject(channel: string): Promise<boolean>;
  claimSteers?(channel: string): Promise<InboxMessage[]>;
  claimAll(channel: string): Promise<InboxMessage[]>;
  complete(ids: string[]): Promise<void>;
  release(ids: string[]): Promise<void>;
}
```

`claimSteers` is optional. It claims only pending `steer` rows, oldest first, and
nothing else. The engine calls it at every turn boundary after the interjection
probe. A store without it treats `steer` as `queue`.

`hasInterject` must be cheap. It runs at every turn boundary and must only count
`interject` rows. A `steer` or `queue` row must not end the run.

`claimAll` must be atomic and leased. A crashed worker must not leave a message
claimed forever. In Postgres, `FOR UPDATE SKIP LOCKED` plus a lease timeout is
the expected shape.

## Engine events

```ts
type InboxEvent =
  | { type: "inbox_delivered"; messages: Array<{ id: string; delivery: InboxDelivery }> }
  | { type: "inbox_interject" }
  | { type: "inbox_steer"; count: number };
```

`inbox_steer` fires when steers are delivered into the running run. An
interjection at the same boundary wins.

## Postgres sketch

```sql
create table anchor_inbox (
  id text primary key,
  channel text not null,
  body text not null,
  context text,
  images jsonb,
  delivery text not null check (delivery in ('queue', 'interject', 'steer')),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'consumed')),
  seq bigserial not null,
  claimed_at timestamptz
);

create index anchor_inbox_claim_idx
  on anchor_inbox (channel, status, delivery, seq);
```

`push` is `insert ... on conflict do nothing`; `rowCount` distinguishes
`queued` from `duplicate`.

`claimSteers` filters `delivery = 'steer'`; `claimAll` orders interjections
newest first, then everything else oldest first. `complete` moves claimed rows
to `consumed`; `release` returns them to `pending`.

## Limits

- The store is the consumer's. The SDK ships `MemoryInboxStore` for tests and
  single-process apps.
- A steer is a nudge, not a correction. It is delivered as an engine user
  message; it does not stop the run or change the contract.
- A steer that arrives after the last turn boundary is not delivered into the
  current run. It waits for the next batch.
- A store without `claimSteers` cannot deliver a steer into the same run.

## Tests

- `tests/unit/inbox.test.ts`
- `tests/unit/inbox-steer.test.ts`
