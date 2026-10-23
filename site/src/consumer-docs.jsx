import React from "react";
import { CodeBlock, repo } from "./ui.jsx";

// Consumer implementations, not SDK internals. The package owns the interfaces;
// the application owns the database, transactions, leases, and credentials.
export function ConsumerDocs({ Section, Callout }) {
  return <>
    <Section id="thread-store" number="25" title="Thread store">
      <p><code>ThreadStore</code> is the one required persistence seam for
        multi-run continuity. Persist <code>messages</code>, <code>summary</code>,
        <code>compaction</code>, <code>phase</code>, and <code>ledger</code> in
        one row. Do not split them across independent writes: a run that saves a
        ledger but loses its messages cannot be reconciled safely.</p>
      <CodeBlock filename="schema.sql" language="SQL" code={`create table anchor_threads (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);`} />
      <CodeBlock filename="postgres-thread-store.ts" code={`import type { StoredThread, ThreadStore } from "anchor-ai-sdk";
import type { Pool } from "pg";

export class PostgresThreadStore implements ThreadStore {
  constructor(private readonly pool: Pool) {}

  async load(id: string): Promise<StoredThread | undefined> {
    const { rows } = await this.pool.query(
      "select state from anchor_threads where id = $1", [id],
    );
    return rows[0]?.state;
  }

  async save(id: string, thread: StoredThread): Promise<void> {
    await this.pool.query(
      \`insert into anchor_threads (id, state, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (id) do update
       set state = excluded.state, updated_at = now()\`,
      [id, JSON.stringify(thread)],
    );
  }
}`} />
      <Callout>The store is allowed to be lossy only by policy, never by
        accident. A failed save must reject so the engine can surface the
        storage failure; silent best-effort persistence is not continuity.</Callout>
    </Section>

    <Section id="inbox-store" number="26" title="Inbox store">
      <p>The inbox is a queue with two delivery modes: <code>queue</code> waits
        for the next run; <code>interject</code> ends the current run at a turn
        boundary. <code>claimAll</code> must be atomic and leased. A crashed
        worker must not leave a message claimed forever.</p>
      <CodeBlock filename="schema.sql" language="SQL" code={`create table anchor_inbox (
  id text primary key,
  channel text not null,
  body text not null,
  context text,
  images jsonb,
  delivery text not null check (delivery in ('queue', 'interject')),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'consumed')),
  seq bigserial not null,
  claimed_at timestamptz
);
create index anchor_inbox_claim_idx
  on anchor_inbox (channel, status, delivery, seq);`} />
      <CodeBlock filename="postgres-inbox-store.ts" code={`import type { InboxMessage, InboxStore } from "anchor-ai-sdk";
import type { Pool } from "pg";

export class PostgresInboxStore implements InboxStore {
  constructor(private readonly pool: Pool) {}

  async push(message: InboxMessage): Promise<"queued" | "duplicate"> {
    const result = await this.pool.query(
      \`insert into anchor_inbox
         (id, channel, body, context, images, delivery)
       values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict do nothing\`,
      [message.id, message.channel, message.text,
       message.context ?? null,
       message.images?.length ? JSON.stringify(message.images) : null,
       message.delivery],
    );
    return result.rowCount ? "queued" : "duplicate";
  }

  async hasInterject(channel: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      \`select 1 from anchor_inbox
       where channel = $1 and status = 'pending'
         and delivery = 'interject' limit 1\`, [channel],
    );
    return rowCount > 0;
  }

  async claimAll(channel: string): Promise<InboxMessage[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query(
        \`select id, channel, body, context, images, delivery
         from anchor_inbox
         where channel = $1 and status = 'pending'
           and (claimed_at is null or claimed_at < now() - interval '5 minutes')
         order by delivery = 'interject' desc, seq asc
         for update skip locked\`, [channel],
      );
      if (rows.length) {
        await client.query(
          \`update anchor_inbox set status = 'claimed', claimed_at = now()
           where channel = $1 and id = any($2::text[])\`,
          [channel, rows.map((row) => row.id)],
        );
      }
      await client.query("commit");
      return rows.map((row) => ({
        id: row.id, channel: row.channel, text: row.body,
        ...(row.context ? { context: row.context } : {}),
        ...(row.images?.length ? { images: row.images } : {}),
        delivery: row.delivery,
      }));
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(ids: string[]): Promise<void> {
    await this.pool.query(
      "update anchor_inbox set status = 'consumed' where id = any($1::text[])",
      [ids],
    );
  }

  async release(ids: string[]): Promise<void> {
    await this.pool.query(
      \`update anchor_inbox set status = 'pending', claimed_at = null
       where id = any($1::text[]) and status = 'claimed'\`,
      [ids],
    );
  }
}`} />
      <Callout><code>claimAll</code> ordering matters: the newest interjection
        wins, then queued messages run oldest-first. The engine completes a
        claimed batch after the run consumes it and releases it on error or
        cancellation.</Callout>
    </Section>

    <Section id="operation-store" number="27" title="Operation store">
      <p>Operation recovery protects writes outside the workspace. The
        <code>operationId</code> must be unique and <code>begin()</code> must be
        durable before the effect runs. A duplicate begin means “already
        recorded”: do not execute the effect again.</p>
      <CodeBlock filename="schema.sql" language="SQL" code={`create table anchor_operations (
  operation_id text primary key,
  scope text not null,
  tool text not null,
  input jsonb not null,
  status text not null,
  started_at bigint not null,
  ack jsonb,
  settled jsonb,
  updated_at timestamptz not null default now()
);
create index anchor_operations_pending_idx
  on anchor_operations (scope)
  where settled is null or settled->>'status' = 'unknown';`} />
      <CodeBlock filename="postgres-operation-store.ts" code={`import type {
  OperationStore, PendingOperation, SettledOperation,
} from "anchor-ai-sdk";
import type { Pool } from "pg";

export class PostgresOperationStore implements OperationStore {
  constructor(private readonly pool: Pool) {}

  async loadPending(scope: string): Promise<PendingOperation[]> {
    const { rows } = await this.pool.query(
      \`select operation_id, scope, tool, input, status, started_at, ack
       from anchor_operations
       where scope = $1
         and (settled is null or settled->>'status' = 'unknown')\`,
      [scope],
    );
    return rows.map((row) => ({
      operationId: row.operation_id, scope: row.scope, tool: row.tool,
      input: row.input, status: row.status, startedAt: Number(row.started_at),
      ...(row.ack ? { ack: row.ack } : {}),
    }));
  }

  async begin(operation: PendingOperation): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      \`insert into anchor_operations
         (operation_id, scope, tool, input, status, started_at)
       values ($1, $2, $3, $4::jsonb, $5, $6)
       on conflict (operation_id) do nothing\`,
      [operation.operationId, operation.scope, operation.tool,
       JSON.stringify(operation.input), operation.status, operation.startedAt],
    );
    return rowCount === 1;
  }

  async acknowledge(operationId: string, ack: Record<string, unknown>) {
    await this.pool.query(
      "update anchor_operations set ack = $2::jsonb where operation_id = $1",
      [operationId, JSON.stringify(ack)],
    );
  }

  async settle(operationId: string, result: SettledOperation) {
    await this.pool.query(
      \`update anchor_operations
       set settled = $2::jsonb, status = $3, updated_at = now()
       where operation_id = $1\`,
      [operationId, JSON.stringify(result), result.status],
    );
  }
}`} />
      <p>On resume, <code>loadPending</code> finds intent/acknowledged/unknown
        rows. The tool's <code>effect.reconcile</code> decides applied /
        not applied / unknown. Unknown is never replayed and ends with
        <code>reason: "recovery_required"</code>.</p>
      <Callout>An operation journal does not create exactly-once behavior by
        itself. The target must supply an idempotency key or a reliable status
        lookup. Without either, the honest result is unknown, not a retry.</Callout>
      <a className="doc-inline-link" href={`${repo}/blob/main/src/engine/operations.ts`}>OperationStore source ↗</a>
    </Section>

    <Section id="sandbox-store" number="28" title="Sandbox store">
      <p><code>SandboxStore</code> stores only the retained handle, not the
        workspace or conversation. The key is consumer-owned: usually a thread
        or task id.</p>
      <CodeBlock filename="postgres-sandbox-store.ts" code={`import type { SandboxStore, SandboxSession } from "anchor-ai-sdk";
import type { Pool } from "pg";

export class PostgresSandboxStore implements SandboxStore {
  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<SandboxSession | null> {
    const { rows } = await this.pool.query(
      "select session from anchor_sandboxes where key = $1", [key],
    );
    return rows[0]?.session ?? null;
  }

  async set(key: string, session: SandboxSession): Promise<void> {
    await this.pool.query(
      \`insert into anchor_sandboxes (key, session)
       values ($1, $2::jsonb)
       on conflict (key) do update set session = excluded.session\`,
      [key, JSON.stringify(session)],
    );
  }

  async clear(key: string): Promise<void> {
    await this.pool.query("delete from anchor_sandboxes where key = $1", [key]);
  }
}`} />
      <Callout>Retention and cleanup are policy. A retained sandbox can keep
        billing or consuming disk; your app must define a janitor and a maximum
        retention window.</Callout>
    </Section>

    <Section id="compaction-contract" number="29" title="Compaction handoff">
      <p>For task/verifier runs, the SDK now uses a structured
        <code>CompactionHandoff</code> instead of another prose summary. The
        consumer does not define a second store or summarizer — it persists the
        field in the existing thread row.</p>
      <CodeBlock filename="stored-thread.ts" code={`interface StoredThread {
  messages: LLMMessage[];
  summary?: string;              // legacy/chat path
  compaction?: CompactionHandoff; // durable task reset state
  phase?: string;
  ledger?: ProgressLedger;
}`} />
      <CodeBlock filename="compaction-handoff.ts" code={`interface CompactionHandoff {
  task: string;
  requirements: {
    id: string; text: string; status: string; evidence: string[];
  }[];
  completed: string[];
  currentState: string;
  openFailures: string[];
  nextSteps: string[];
  constraints: string[];
  lastObservations: string[];
  git: { head?: string; checkpoint?: string; dirty?: boolean };
}`} />
      <p>When a task conversation crosses its compaction threshold, the engine
        writes a handoff, saves it with the thread, drops the old summarized
        span, and starts a fresh window with the pinned task/ledger + handoff
        + a recent verbatim tail. Your <code>ThreadStore</code> must round-trip
        <code>compaction</code>; no new table is required.</p>
      <Callout>Chat turns still use the existing prose <code>summary</code>.
        The structured path is scoped to active task/ledger runs so a simple
        conversation does not pay for a contract it does not need.</Callout>
    </Section>
  </>;
}
