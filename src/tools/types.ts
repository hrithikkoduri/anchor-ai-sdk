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
  /** Set by finish(); the loop stops once this fires. */
  onFinish?: (summary: string) => void;
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
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Wrap a definition + implementation, turning thrown validation errors into ok:false results. */
export function defineTool(
  definition: ToolDefinition,
  run: (
    input: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>,
  options: Pick<Tool, "verb"> = {},
): Tool {
  return {
    definition,
    ...options,
    run: async (input, ctx) => {
      try {
        return await run(input, ctx);
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
