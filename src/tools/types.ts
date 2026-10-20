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
  /** Structured data for the trace; never sent to the model. */
  meta?: Record<string, unknown>;
  /** Human-readable activity label for traces and chat, e.g. "Reading README.md". */
  verb?: string;
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
   * This tool may hand a long command to the background when the consumer
   * opted in and the sandbox can poll. It is a permission, not a promise:
   * see `execPolicy` for the decision. `bash` sets it.
   */
  background?: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Wrap a definition + implementation, turning thrown validation errors into ok:false results. */
export function defineTool(
  definition: ToolDefinition,
  run: (
    input: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>,
  options: Pick<Tool, "verb" | "readOnly" | "background"> = {},
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
