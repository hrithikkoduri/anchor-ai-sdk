/**
 * Operations — the recovery contract for tool calls with external effects.
 *
 * A crash between "the target accepted the write" and "the thread saved the
 * result" is the dangerous window: without a record, recovery reads the absence
 * of a result as "not done" and repeats the write. This layer removes that
 * guess:
 *
 *   1. mint an `operationId` (stable across retries),
 *   2. `begin()` — durably record the intent BEFORE the tool runs,
 *   3. let the tool forward the id to the target as an idempotency key,
 *   4. `settle()` with the observed result.
 *
 * On resume, a pending operation is never replayed blindly. The engine asks the
 * tool's `effect.reconcile()`: applied → adopt the result; not applied → the
 * write is safe to attempt again (with the same id); unknown → stop and report.
 *
 * The store is the consumer's (a database in production, `MemoryOperationStore`
 * for tests), exactly like `ThreadStore` and `InboxStore`. The package owns the
 * lifecycle and minting; it never owns the durable table.
 */
import { randomUUID } from "node:crypto";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";

/** Where an operation stands while it is still recoverable. */
export type OperationStatus = "intent" | "acknowledged" | "unknown";

/** One operation that may not have finished. */
export interface PendingOperation {
  /** Stable identity: the target's idempotency key. */
  operationId: string;
  /** The recovery scope — usually a thread id. */
  scope: string;
  /** Tool name that produced the effect. */
  tool: string;
  /** The validated input the tool ran with. */
  input: Record<string, unknown>;
  status: OperationStatus;
  /** Epoch ms when the intent was recorded. */
  startedAt: number;
  /** Target acceptance (a 202, a job id, a message id), when reported. */
  ack?: Record<string, unknown>;
}

/** How an operation ended. `"unknown"` stays recoverable. */
export interface SettledOperation {
  status: "completed" | "failed" | "unknown";
  ok?: boolean;
  content?: string;
  meta?: Record<string, unknown>;
  settledAt?: number;
}

/**
 * Durable operation storage. Implementations MUST make `begin()` durable
 * before it resolves — the whole guarantee rests on that write surviving a
 * crash. `operationId` is unique; a duplicate begin is an idempotent no-op
 * (the `on conflict do nothing` shape), never a second row.
 */
export interface OperationStore {
  /** Every operation for a scope that is not definitely finished. */
  loadPending(scope: string): Promise<PendingOperation[]>;
  /**
   * Record the intent. Durable before resolving. Returns `true` when this call
   * created the record; `false` when the id already exists (a repeated domain
   * key), in which case the effect MUST NOT run again.
   */
  begin(operation: PendingOperation): Promise<boolean>;
  /** Record target acceptance, when the tool reports it. */
  acknowledge(operationId: string, ack: Record<string, unknown>): Promise<void>;
  /** Close the operation with its observed outcome. */
  settle(operationId: string, result: SettledOperation): Promise<void>;
}

/** A fresh, stable-per-call operation id. */
export function mintOperationId(): string {
  return `op_${randomUUID()}`;
}

/** Map a tool result onto the journal's terminal shape. */
export function settleFromResult(result: ToolResult): SettledOperation {
  return {
    status:
      result.completion === "unknown"
        ? "unknown"
        : result.ok
          ? "completed"
          : "failed",
    ok: result.ok,
    content: result.content,
    ...(result.meta !== undefined ? { meta: result.meta } : {}),
    settledAt: Date.now(),
  };
}

/** In-memory operations: tests, demos, single-process apps. Not crash-durable. */
export class MemoryOperationStore implements OperationStore {
  private readonly rows = new Map<
    string,
    PendingOperation & { settled?: SettledOperation }
  >();

  async loadPending(scope: string): Promise<PendingOperation[]> {
    const pending: PendingOperation[] = [];
    for (const row of this.rows.values()) {
      if (row.scope !== scope) continue;
      // "unknown" is recoverable, not finished: keep asking about it.
      if (row.settled !== undefined && row.settled.status !== "unknown") continue;
      const { settled: _settled, ...operation } = row;
      pending.push({ ...operation });
    }
    return pending;
  }

  async begin(operation: PendingOperation): Promise<boolean> {
    if (this.rows.has(operation.operationId)) return false; // idempotent insert
    this.rows.set(operation.operationId, { ...operation });
    return true;
  }

  async acknowledge(
    operationId: string,
    ack: Record<string, unknown>,
  ): Promise<void> {
    const row = this.rows.get(operationId);
    if (!row || row.settled !== undefined) return;
    row.status = "acknowledged";
    row.ack = { ...(row.ack ?? {}), ...ack };
  }

  async settle(operationId: string, result: SettledOperation): Promise<void> {
    const row = this.rows.get(operationId);
    if (!row) return;
    row.settled = { ...result };
    row.status = result.status === "unknown" ? "unknown" : row.status;
  }

  /** Diagnostic: the recorded state of one operation. */
  get(operationId: string):
    | (PendingOperation & { settled?: SettledOperation })
    | undefined {
    const row = this.rows.get(operationId);
    return row === undefined ? undefined : structuredClone(row);
  }
}

/** What reconciliation found for one pending operation. */
export interface ReconcileOutcome {
  operation: PendingOperation;
  status: "applied" | "not_applied" | "unknown";
  result?: ToolResult;
  detail?: string;
}

/**
 * Resolve pending operations before a run starts. Applied operations are
 * settled and returned so the caller can tell the model; not-applied ones are
 * settled as failed; unknown ones stay pending and MUST block a replay.
 */
export async function reconcilePendingOperations(args: {
  store: OperationStore;
  scope: string;
  tools: Tool[];
  context: ToolContext;
}): Promise<ReconcileOutcome[]> {
  const pending = await args.store.loadPending(args.scope);
  const outcomes: ReconcileOutcome[] = [];
  for (const operation of pending) {
    const tool = args.tools.find(
      (candidate) => candidate.definition.name === operation.tool,
    );
    const reconcile = tool?.effect?.reconcile;
    if (!reconcile) {
      outcomes.push({
        operation,
        status: "unknown",
        detail: `tool "${operation.tool}" has no reconcile contract`,
      });
      continue;
    }
    try {
      const outcome = await reconcile({
        operationId: operation.operationId,
        input: operation.input,
        ctx: { ...args.context, operationId: operation.operationId },
      });
      if (outcome.status === "applied") {
        const result = outcome.result ?? {
          ok: true,
          content: `Operation ${operation.operationId} was already applied.`,
        };
        await args.store.settle(
          operation.operationId,
          settleFromResult(result),
        );
        outcomes.push({ operation, status: "applied", result });
      } else if (outcome.status === "not_applied") {
        await args.store.settle(operation.operationId, {
          status: "failed",
          ok: false,
          content: `Operation ${operation.operationId} was not applied.`,
          settledAt: Date.now(),
        });
        outcomes.push({ operation, status: "not_applied" });
      } else {
        outcomes.push({
          operation,
          status: "unknown",
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        });
      }
    } catch (err) {
      outcomes.push({
        operation,
        status: "unknown",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}
