/**
 * The Tool contract.
 *
 * Tools are what the model sees. Every tool ultimately drives `sandbox.exec()`
 * — the tool-call contract (self-contained commands, real kill deadlines) is
 * enforced once, in the sandbox adapters, and tools never bypass it.
 *
 * `definition` speaks the model's language (JSON Schema for function calling);
 * `run` produces a `ToolResult` for the loop and structured `meta` for the
 * trace. Outputs are truncated inside the tools, so nothing untruncated can
 * reach the context.
 */
import type { Sandbox } from "../sandbox/types.js";
import type { ExecResult } from "../sandbox/types.js";
import type { RepoRef } from "../repo.js";
import type { JsonObject } from "../json.js";

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object for the function-calling API. */
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  /**
   * Where commands execute. Optional: sandbox-free agents (chat, plain tool
   * loops) omit it; tools that need it call `requireSandbox(ctx)` and fail
   * with a clear message instead of crashing the run.
   */
  sandbox?: Sandbox;
  /** Peer repositories in the sandbox workspace; absent = workspace root repo. */
  repos?: RepoRef[];
  /**
   * Stable identity for THIS effect, minted before the call and preserved
   * across crashes/retries. Forward it to the target as its idempotency key
   * (an `Idempotency-Key` header, a unique column, a metadata field). Absent
   * when the tool declares no `effect` or the run has no operation store.
   */
  operationId?: string;
  /**
   * Record that the target ACCEPTED the request, before the observed result is
   * known (a 202, a job id, a message id). Best-effort: a store outage must not
   * turn an accepted write into a failed one.
   */
  acknowledge?: (ack: Record<string, unknown>) => Promise<void>;
  /**
   * The consumer's background threshold. When set, tools that can detach a
   * long command (bash) return control at this point and hand the job to the
   * harness, which delivers the completion as a later turn. Unset = stay
   * synchronous (the default).
   */
  backgroundAfterSecs?: number;
  /**
   * Set by `defineTool` from the Tool's `background` flag. A tool that may
   * detach checks this instead of knowing its own metadata; the consumer's
   * threshold and the sandbox's `pollJob` are checked by `execPolicy`.
   */
  backgroundAllowed?: boolean;
  /** Set by finish(); the loop stops once this fires. */
  onFinish?: (summary: string) => void;
  /** Engine tool-call id, available to delegates for trace attribution. */
  callId?: string;
  /**
   * The run's cancellation/tool-deadline signal. A tool that runs long
   * external work SHOULD observe it and abort: the engine passes the same
   * signal on a host cancel and when a delegated child's wall-clock budget
   * expires, so the in-flight call is cut instead of outliving its turn.
   * Absent for callers that run tools outside the engine.
   */
  signal?: AbortSignal;
  /**
   * Who is calling, inside a delegated run: the worker instance and its roster
   * member. Workers of one member share tool instances, so a tool that files
   * work under the worker (artifacts, notes) reads it here. Absent for the leader.
   */
  team?: { worker: string; member: string; role: "worker" | "evaluator" };
}

/**
 * The detach policy every tool shares. `background: true` on the tool say it
 * CAN detach; this decides whether it may here: the consumer opted in
 * (`backgroundAfterSecs`), the sandbox can poll (Heyo today), and the command
 * is allowed to outlive the threshold. An explicit short deadline stays a
 * deadline. Tools without the flag never detach.
 */
export function execPolicy(
  ctx: ToolContext,
  explicitTimeoutSecs = 0,
): { canBackground: boolean; timeoutSecs: number; backgroundAfterSecs?: number } {
  const threshold = ctx.backgroundAfterSecs;
  const canBackground =
    ctx.backgroundAllowed === true &&
    threshold !== undefined &&
    threshold > 0 &&
    typeof ctx.sandbox?.pollJob === "function";
  const timeoutSecs = Math.max(
    1,
    Math.min(
      3600,
      explicitTimeoutSecs > 0 ? explicitTimeoutSecs : canBackground ? 3600 : 120,
    ),
  );
  return {
    canBackground,
    timeoutSecs,
    ...(canBackground && timeoutSecs > threshold
      ? { backgroundAfterSecs: threshold }
      : {}),
  };
}

/** Guard for tools that cannot work without an execution environment. */
export function requireSandbox(ctx: ToolContext): Sandbox {
  if (!ctx.sandbox) {
    throw new Error(
      "this tool needs a sandbox — pass EngineOptions.sandbox (or use a sandbox-free strategy)",
    );
  }
  return ctx.sandbox;
}

export interface ToolResult {
  /** Did the tool accomplish what was asked? (exit 0, edit applied, …) */
  ok: boolean;
  /** Text that goes back to the model — already truncated. */
  content: string;
  /**
   * `"unknown"` means the effect MAY or MAY NOT have landed (the request was
   * sent and the response was lost). It is not a failure and must never be
   * retried automatically. Default: `"observed"`.
   */
  completion?: "observed" | "unknown";
  /**
   * Structured data for the trace and evidence; never sent to the model.
   * Plain JSON only: it is persisted by consumers and captured into the task
   * ledger, so it must not alias engine state or carry non-serializable values.
   */
  meta?: JsonObject;
  /** Human-readable activity label for traces and chat, e.g. "Reading README.md". */
  verb?: string;
}

/** What a target needs in order to survive a crash between effect and result. */
export interface ToolEffect {
  /**
   * A stable key for the intended effect, derived from the input (e.g.
   * `refund:order_123`). Default: a fresh UUID per call. Use a derived key
   * when the same business action can be attempted from another run.
   */
  key?: (input: Record<string, unknown>) => string;
  /** Retrying with the same `operationId` is safe: the target dedupes it. */
  idempotent?: boolean;
  /**
   * Ask the target whether a pending operation from a crashed run landed.
   * Called on resume, before the first model turn. Returning `"unknown"` is
   * always correct when the target cannot answer definitively — the engine
   * then stops instead of replaying the write.
   */
  reconcile?: (args: {
    operationId: string;
    input: Record<string, unknown>;
    ctx: ToolContext;
  }) => Promise<
    | { status: "applied"; result?: ToolResult }
    | { status: "not_applied" }
    | { status: "unknown"; detail?: string }
  >;
}

export interface Tool {
  definition: ToolDefinition;
  /** Presentation metadata, never added to the provider's function schema. */
  verb?: string | ((input: Record<string, unknown>) => string);
  /**
   * The tool only reads the workspace. The engine may execute several
   * read-only calls from one model turn concurrently; mutations stay serial.
   */
  readOnly?: boolean;
  /**
   * Per-call form of `readOnly`, for a tool that only SOMETIMES reads (bash:
   * `git status` reads, `npm install` writes). True means this particular
   * call may run concurrently with the turn's other read-only calls. It never
   * makes the tool read-only as a whole (a read-only team member still does
   * not get it), and an effectful tool is never treated as read-only.
   */
  readOnlyWhen?: (input: Record<string, unknown>) => boolean;
  /**
   * This tool may hand a long command to the background when the consumer
   * opted in and the sandbox can poll. It is a permission, not a promise:
   * see `execPolicy` for the decision. `bash` sets it.
   */
  background?: boolean;
  /**
   * Declares an EXTERNAL effect (a write outside the workspace). The engine
   * then journals the intent before running the tool and settles it after, when
   * an `OperationStore` is configured. Tools without `effect` keep today's
   * behavior exactly: no journal, no operation id.
   */
  effect?: ToolEffect;
  /**
   * Mutually exclusive resource for mutation dispatch. A repository name
   * serializes only calls in that repo; undefined is the global group.
   */
  resource?: (input: Record<string, unknown>, ctx: ToolContext) => string | undefined;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** May this call run beside the turn's other read-only calls? A throwing predicate says no. */
export function isReadOnlyCall(
  tool: Tool | undefined,
  input: Record<string, unknown>,
): boolean {
  if (!tool || tool.effect !== undefined) return false;
  if (tool.readOnly === true) return true;
  try {
    return tool.readOnlyWhen?.(input) === true;
  } catch {
    return false;
  }
}

/** Wrap a definition + implementation, turning thrown validation errors into ok:false results. */
export function defineTool(
  definition: ToolDefinition,
  run: (
    input: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>,
  options: Pick<Tool, "verb" | "readOnly" | "readOnlyWhen" | "background" | "effect" | "resource"> = {},
): Tool {
  return {
    definition,
    ...options,
    run: async (input, ctx) => {
      try {
        return await run(input, {
          ...ctx,
          backgroundAllowed: options.background === true,
        });
      } catch (err) {
        return {
          ok: false,
          content: `error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

// --- input validators (the model's JSON is untrusted) -----------------------

export function requireString(
  input: Record<string, unknown>,
  key: string,
): string {
  const v = input[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return v;
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = input[key];
  if (v === undefined || v === null) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${key}" must be a number`);
  return n;
}

export function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new Error(`"${key}" must be a boolean`);
  return v;
}

/** One-line header + body, the shape every exec-backed tool returns. */
export function formatExec(
  r: Pick<ExecResult, "exitCode" | "output" | "timedOut"> &
    Partial<Pick<ExecResult, "failure" | "durationMs">>,
  timeoutSecs: number,
): string {
  const status =
    r.exitCode === -1 || r.failure
      ? `execution request failed${r.durationMs !== undefined ? ` after ${(r.durationMs / 1000).toFixed(1)}s` : ""}; command completion is unknown (not confirmed killed)`
      : r.timedOut
        ? `command exceeded its ${timeoutSecs}s deadline (exit ${r.exitCode})`
        : `exit code ${r.exitCode}`;
  const body = r.output.trim() === "" ? "(no output)" : r.output.trimEnd();
  return `${status}\n${body}`;
}
