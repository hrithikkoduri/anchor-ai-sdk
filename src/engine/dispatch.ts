/**
 * Tool-call dispatch: the shapes a model turn can take.
 *
 * Calls run in the model's order, so a `finish` or a pause is observed before
 * later calls. Within that order, each maximal run of consecutive read-only
 * calls (statically `readOnly`, or `readOnlyWhen(input)` — a read-only `bash`
 * command) runs concurrently, at most `MAX_PARALLEL_TOOL_CALLS` at a time; a
 * mutating or unknown call always runs alone, after everything before it and
 * before everything after it. Results are appended in call order whatever the
 * completion order, so the conversation is deterministic. Mutations on
 * distinct repositories have their own grouped path. All paths reuse the same
 * repetition tracker and emit the same events, which is why they live
 * together: splitting them is how they drift.
 */
import { toPlainJsonObject } from "../json.js";
import { toolCallEventKey } from "../checkpoints.js";
import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import type { Tool } from "../tools/types.js";
import { isReadOnlyCall, type ToolContext } from "../tools/types.js";
import type { ToolResult } from "../tools/types.js";
import { toolVerb } from "../tools/activity.js";
import { boundToolResult, TOOL_RESULT_MAX_CHARS } from "../tools/truncate.js";
import { toolResultMessage } from "./context.js";
import type { EventSink } from "./events.js";
import type { ToolResultRecord } from "./strategy.js";
import type { RepeatTracker } from "./guardrails.js";
import type { BackgroundJob } from "./types.js";

/**
 * Concurrency cap for one group of read-only calls. Small on purpose: every
 * call is a sandbox exec, and the gain is in overlapping two or three round
 * trips, not in fanning out without bound.
 */
export const MAX_PARALLEL_TOOL_CALLS = 4;

/** Run `fn` over `items`, at most `limit` at once; results keep input order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

/** Is this call eligible for a concurrent read group? */
function readOnlyCall(call: LLMToolCall, available: Map<string, Tool>): boolean {
  const { input, invalid } = parseInput(call);
  const tool = available.get(call.name);
  // Invalid arguments never reach a predicate; a statically read-only tool
  // stays eligible (it returns the parse error as its result).
  if (invalid !== undefined) return tool?.readOnly === true && tool.effect === undefined;
  return isReadOnlyCall(tool, input);
}

/** What `finish` declared, if the turn called it. */
export interface DeclaredOutcome {
  ok: boolean;
  summary: string;
  handoff?: Record<string, unknown>;
}

/**
 * The engine's write-ahead hook for tools that declare an `effect`. Dispatch
 * owns the ordering (begin → run → settle); the loop owns ids, storage, and
 * events. Kept as an interface so dispatch never learns about the store.
 */
export interface OperationRuntime {
  /**
   * Record the intent and return its operation id. Must be durable. `started`
   * is false when the id already existed (a repeated domain key): the effect
   * must not run a second time.
   */
  begin(
    call: LLMToolCall,
    input: Record<string, unknown>,
    tool: Tool,
  ): Promise<{ operationId: string; started: boolean }>;
  /** Record that the target accepted the request. */
  acknowledge(operationId: string, ack: Record<string, unknown>): Promise<void>;
  /** Close the operation. False when the journal write failed. */
  settle(operationId: string, result: ToolResult): Promise<boolean>;
}

export interface ToolDispatchArgs {
  calls: LLMToolCall[];
  available: Map<string, Tool>;
  steps: number;
  /** Absent when the run has phases off. */
  phase?: string;
  toolContext: ToolContext;
  /** The intrinsic `finish` tool, to compare identity against. */
  finish: Tool;
  repeat: RepeatTracker;
  messages: LLMMessage[];
  evidence: ToolResultRecord[];
  emit: EventSink;
  emitBackground: (
    name: string,
    callId: string | undefined,
    result: ToolResult,
  ) => void;
  /** Present when the run has an operation store; absent keeps today's path. */
  operations?: OperationRuntime;
  /** Called once per effectful tool when no store is configured. */
  onMissingJournal?: (tool: Tool) => void;
  signal?: AbortSignal;
  /** Read live: a `pause` tool sets it during this very dispatch. */
  pauseRequested: () => boolean;
  /** Engine-owned evidence capture; called once per tool result. */
  onToolResult?: (call: LLMToolCall, result: ToolResult) => void;
}

export interface ToolDispatchOutcome {
  /** The repetition limit was hit; the caller decides whether to nudge. */
  runaway: boolean;
  declared?: DeclaredOutcome;
  /** Commands this turn detached; the loop polls them from now on. */
  jobs: BackgroundJob[];
  /**
   * Completed effectful calls. The loop settles them AFTER the conversation is
   * durable, so a crash can never leave a settled journal entry whose result
   * the next run cannot see.
   */
  settlements: Array<{ operationId: string; result: ToolResult }>;
}

/** Parse a call's arguments; an invalid JSON payload is a tool result, not a throw. */
function parseInput(call: LLMToolCall): {
  input: Record<string, unknown>;
  invalid?: string;
} {
  try {
    const parsed: unknown = call.arguments.trim()
      ? JSON.parse(call.arguments)
      : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return { input: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      input: {},
      invalid: `tool arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Run one tool call, turning a throw into a failed tool result. */
async function invoke(
  tool: Tool | undefined,
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  available: Map<string, Tool>,
): Promise<
  { result: ToolResult } | { invalid: string }
> {
  if (!tool) {
    return {
      invalid: `unknown tool "${name}" — available: ${[...available.keys()].join(", ")}`,
    };
  }
  try {
    const raw = await tool.run(input, ctx);
    // The result is captured as evidence and persisted by consumers. Make it
    // plain here, once: the model text is a string, meta is a detached JSON
    // copy, so a tool can neither alias engine state nor smuggle a cycle.
    const content = typeof raw.content === "string" ? raw.content : String(raw.content ?? "");
    const meta = toPlainJsonObject(raw.meta);
    const result: ToolResult = {
      ...raw,
      ok: raw.ok === true,
      content,
      ...(meta ? { meta } : {}),
    };
    if (!meta) delete result.meta;
    // Consumer tools are not required to know the truncation policy. Enforce
    // one ceiling here so a badly behaved tool cannot flood context.
    if (result.content.length > TOOL_RESULT_MAX_CHARS) {
      return {
        result: {
          ...result,
          content: await boundToolResult(result.content, {
            ...(ctx.sandbox ? { sandbox: ctx.sandbox } : {}),
            label: `tool-${name}`,
          }),
        },
      };
    }
    return { result };
  } catch (err) {
    return {
      result: {
        ok: false,
        content: `error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/** A call's resource key, when it may run beside calls on other resources. */
function resourceKey(call: LLMToolCall, available: Map<string, Tool>, ctx: ToolContext): string | undefined {
  const tool = available.get(call.name);
  if (!tool || tool.readOnly === true || tool.effect !== undefined || !tool.resource) return undefined;
  const { input, invalid } = parseInput(call);
  if (invalid !== undefined) return undefined;
  try {
    return tool.resource(input, ctx);
  } catch {
    return undefined;
  }
}

/**
 * Where a turn's grouped tail begins: a turn that opens with ordinary calls
 * (`set_phase`, a note) and ends in calls on distinct resources (delegations
 * to different workers) runs its opening in order, then its tail grouped —
 * one ordinary call must not serialize a fan-out. The opening may not
 * conclude the turn or carry an effect. 0 when the turn has no such tail.
 */
function groupedTailStart(calls: LLMToolCall[], available: Map<string, Tool>, ctx: ToolContext, finish: Tool): number {
  const keys = calls.map((call) => resourceKey(call, available, ctx));
  const start = keys.findIndex((key) => key !== undefined);
  if (start <= 0) return 0;
  const tail = keys.slice(start);
  if (!tail.every((key): key is string => typeof key === "string") || new Set(tail).size < 2) return 0;
  const opening = calls.slice(0, start).map((call) => available.get(call.name));
  if (opening.some((tool) => !tool || tool === finish || tool.effect !== undefined)) return 0;
  return start;
}

/** A tool's own idempotency key for an effect, when it derives one. Guarded: a throwing key contributes none. */
function effectKeyOf(tool: Tool, input: Record<string, unknown>): string | undefined {
  try {
    const key = tool.effect?.key?.(input);
    return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Execute a turn's tool calls and emit their results.
 *
 * Returns the repetition verdict and, when `finish` ran, what it declared.
 */
export async function dispatchToolCalls(
  args: ToolDispatchArgs,
): Promise<ToolDispatchOutcome> {
  // A turn of nothing but reads is one capped read group, never split.
  const allReads =
    args.calls.length > 1 &&
    args.calls.every((call) => readOnlyCall(call, args.available));
  const tailStart = allReads
    ? 0
    : groupedTailStart(args.calls, args.available, args.toolContext, args.finish);
  if (tailStart > 0) {
    // In order, the opening; then the tail, which groups (or, if the opening
    // paused or was cancelled, is skipped by the same rules as any call).
    const head = await dispatchToolCalls({ ...args, calls: args.calls.slice(0, tailStart) });
    const tail = await dispatchToolCalls({ ...args, calls: args.calls.slice(tailStart) });
    return {
      runaway: head.runaway || tail.runaway,
      jobs: [...head.jobs, ...tail.jobs],
      settlements: [...head.settlements, ...tail.settlements],
      ...(head.declared ?? tail.declared ? { declared: head.declared ?? tail.declared } : {}),
    };
  }
  const {
    calls,
    available,
    steps,
    phase,
    toolContext,
    finish,
    repeat,
    messages,
    evidence,
    emit,
    emitBackground,
    signal,
  } = args;
  let declared: DeclaredOutcome | undefined;
  let runaway = false;
  const jobs: BackgroundJob[] = [];
  const settlements: Array<{ operationId: string; result: ToolResult }> = [];

  const emitResult = (
    call: LLMToolCall,
    verb: string | undefined,
    result: ToolResult,
    operationId?: string,
    eventKey?: string,
  ): void => {
    args.onToolResult?.(call, result);
    evidence.push({ tool: call.name, ok: result.ok, meta: result.meta });
    emit({
      type: "tool_result",
      name: call.name,
      callId: call.id,
      ...(operationId ? { operationId } : {}),
      ...(eventKey ? { eventKey } : {}),
      verb: result.verb ?? verb,
      ...(phase !== undefined ? { phase } : {}),
      step: steps,
      ok: result.ok,
      outcome:
        result.completion === "unknown"
          ? "unknown"
          : result.ok
            ? "completed"
            : "failed",
      content: result.content,
      contentChars: result.content.length,
      meta: result.meta,
    });
    messages.push(toolResultMessage(call.id, result.content));
    emitBackground(call.name, call.id, result);
    // The tool told the model "moved to the background"; the engine now owns
    // the result and will poll it at every turn boundary.
    const meta = result.meta as
      | { background?: { jobId?: unknown }; command?: unknown; timeoutSecs?: unknown }
      | undefined;
    const jobId = meta?.background?.jobId;
    if (typeof jobId === "string" && jobId !== "") {
      jobs.push({
        jobId,
        tool: call.name,
        ...(typeof meta?.command === "string" ? { command: meta.command } : {}),
        startedAt: Date.now(),
        ...(typeof meta?.timeoutSecs === "number"
          ? { timeoutSecs: meta.timeoutSecs }
          : {}),
      });
    }
  };

  // Resource-grouped mutation path. Only non-effect mutations with distinct
  // repository keys are eligible; anything global/effectful/finish falls back
  // to the fully ordered path below. Results are still emitted in call order.
  if (calls.length > 1 && !allReads && !declared && !args.pauseRequested() && !signal?.aborted) {
    const prepared = calls.map((call) => {
      const tool = available.get(call.name);
      const { input, invalid } = parseInput(call);
      const verb = toolVerb(call.name, input, tool?.verb);
      const key =
        invalid === undefined &&
        tool &&
        tool.readOnly !== true &&
        tool.effect === undefined &&
        tool.resource
          ? (() => {
              try {
                return tool.resource!(input, toolContext);
              } catch {
                return undefined;
              }
            })()
          : undefined;
      return { call, tool, input, invalid, verb, key };
    });
    const keys = prepared.map((item) => item.key);
    const grouped =
      keys.every((key): key is string => typeof key === "string") &&
      new Set(keys).size > 1;
    if (grouped) {
      for (const item of prepared) {
        if (repeat.record(`${item.call.name}:${item.call.arguments}`)) {
          runaway = true;
        }
        emit({
          type: "tool_call",
          name: item.call.name,
          callId: item.call.id,
          input: item.input,
          verb: item.verb,
          ...(phase !== undefined ? { phase } : {}),
          step: steps,
        });
      }
      const groups = new Map<string, typeof prepared>();
      for (const item of prepared) {
        const key = item.key!;
        const list = groups.get(key) ?? [];
        list.push(item);
        groups.set(key, list);
      }
      const results = new Map<string, ToolResult>();
      await Promise.all(
        [...groups.values()].map(async (group) => {
          for (const item of group) {
            if (runaway || signal?.aborted || args.pauseRequested()) {
              results.set(
                item.call.id,
                {
                  ok: false,
                  content: runaway
                    ? "Not executed: repeated identical calls reached the loop limit."
                    : signal?.aborted
                      ? "Not executed: cancelled by signal."
                      : "Not executed: the caller requested a pause.",
                },
              );
              continue;
            }
            if (item.invalid) {
              results.set(item.call.id, { ok: false, content: item.invalid });
              continue;
            }
            const outcome = await invoke(
              item.tool,
              item.call.name,
              item.input,
              { ...toolContext, callId: item.call.id, ...(signal ? { signal } : {}) },
              available,
            );
            results.set(
              item.call.id,
              "invalid" in outcome
                ? { ok: false, content: outcome.invalid }
                : outcome.result,
            );
          }
        }),
      );
      for (const item of prepared) {
        emitResult(item.call, item.verb, results.get(item.call.id)!);
      }
      return { runaway, jobs, settlements };
    }
  }

  /** Why a call will not run, evaluated live at its turn in the order. */
  const skipReason = (): string | undefined =>
    declared !== undefined
      ? "Not executed: the turn was already concluded."
      : args.pauseRequested()
        ? "Not executed: the caller requested a pause at this phase boundary."
        : signal?.aborted
          ? "Not executed: cancelled by signal."
          : runaway
            ? "Not executed: repeated identical calls reached the loop limit."
            : undefined;

  const runOne = async (call: LLMToolCall, ordinal: number): Promise<void> => {
    const tool = available.get(call.name);
    const { input, invalid } = parseInput(call);
    const verb = toolVerb(call.name, input, tool?.verb);
    if (repeat.record(`${call.name}:${call.arguments}`)) runaway = true;
    const skipped = skipReason();

    // The journal key for an effectful call, derived from the work so a resume
    // that re-issues the write is recognised as a duplicate. Read-only calls
    // carry none — they change nothing the log must dedupe. Computed here,
    // before the write-ahead, so both the intent and the result share it.
    const effectKey = tool?.effect
      ? effectKeyOf(tool, input)
      : undefined;
    // Only a consumer-derived key counts; without one the call carries no key
    // and the operations store's reconcile path decides whether it may replay.
    const eventKey = effectKey !== undefined
      ? toolCallEventKey({ tool: call.name, effectKey })
      : undefined;

    // Write-ahead: an effectful call records its intent BEFORE it runs, so a
    // crash between the target's write and our result leaves a pending record
    // instead of a silent replay. A journal failure fails closed.
    let operationId: string | undefined;
    let operationStarted = false;
    let operationError: string | undefined;
    if (skipped === undefined && invalid === undefined && tool?.effect) {
      if (args.operations) {
        try {
          const begun = await args.operations.begin(call, input, tool);
          operationId = begun.operationId;
          operationStarted = begun.started;
          if (!begun.started)
            operationError =
              `Not executed: operation ${begun.operationId} is already recorded — ` +
              "reconcile or resolve it instead of repeating the effect.";
        } catch (err) {
          operationError =
            `Not executed: could not record the operation before running it (${err instanceof Error ? err.message : String(err)}).`;
        }
      } else {
        args.onMissingJournal?.(tool);
      }
    }

    emit({
      type: "tool_call",
      name: call.name,
      callId: call.id,
      ...(operationId ? { operationId } : {}),
      ...(eventKey ? { eventKey } : {}),
      input,
      verb,
      ...(phase !== undefined ? { phase } : {}),
      step: steps,
    });

    let result: ToolResult;
    if (skipped !== undefined) {
      result = { ok: false, content: skipped };
    } else if (operationError) {
      result = { ok: false, content: operationError };
    } else if (invalid) {
      result = { ok: false, content: invalid };
    } else {
      const callContext: ToolContext = {
        ...toolContext,
        callId: call.id,
        ...(signal ? { signal } : {}),
        ...(operationId && args.operations
          ? {
              operationId,
              acknowledge: (ack: Record<string, unknown>) =>
                args.operations!.acknowledge(operationId!, ack),
            }
          : {}),
      };
      const outcome = await invoke(tool, call.name, input, callContext, available);
      if ("invalid" in outcome) {
        result = { ok: false, content: outcome.invalid };
      } else {
        result = outcome.result;
        if (call.name === "finish" && tool === finish && result.ok) {
          const meta = result.meta ?? {};
          const handoff = meta.handoff;
          declared = {
            ok: meta.success !== false,
            summary: String(meta.summary ?? ""),
            ...(handoff !== undefined &&
            typeof handoff === "object" &&
            handoff !== null
              ? { handoff: handoff as Record<string, unknown> }
              : {}),
          };
        }
      }
    }
    // Close the operation. A journal failure here is the same ambiguity as a
    // crash: the effect may have landed, the record did not. Say so.
    if (operationId && operationStarted && args.operations)
      settlements.push({ operationId, result });
    emitResult(call, verb, result, operationId, eventKey);
  };

  /**
   * Consecutive read-only calls: announce them in order, run them bounded,
   * append their results in order. A failure is its own result; it never
   * cancels a sibling. Read-only calls carry no effect, so no journal.
   */
  const runReadGroup = async (group: LLMToolCall[]): Promise<void> => {
    const prepared = group.map((call) => {
      const tool = available.get(call.name);
      const { input, invalid } = parseInput(call);
      const verb = toolVerb(call.name, input, tool?.verb);
      if (repeat.record(`${call.name}:${call.arguments}`)) runaway = true;
      const skipped = skipReason();
      emit({
        type: "tool_call",
        name: call.name,
        callId: call.id,
        input,
        verb,
        ...(phase !== undefined ? { phase } : {}),
        step: steps,
      });
      return { call, tool, input, invalid, verb, skipped };
    });
    const results = await mapBounded(
      prepared,
      MAX_PARALLEL_TOOL_CALLS,
      async ({ call, tool, input, invalid, skipped }): Promise<ToolResult> => {
        if (skipped !== undefined) return { ok: false, content: skipped };
        // A call still queued behind the cap when the run is cancelled does not start.
        if (signal?.aborted)
          return { ok: false, content: "Not executed: cancelled by signal." };
        if (invalid) return { ok: false, content: invalid };
        try {
          const outcome = await invoke(
            tool,
            call.name,
            input,
            { ...toolContext, callId: call.id, ...(signal ? { signal } : {}) },
            available,
          );
          return "invalid" in outcome
            ? { ok: false, content: outcome.invalid }
            : outcome.result;
        } catch (err) {
          return {
            ok: false,
            content: `error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    );
    prepared.forEach(({ call, verb }, i) => emitResult(call, verb, results[i]!));
  };

  const reads = calls.map((call) => readOnlyCall(call, available));
  for (let i = 0; i < calls.length; ) {
    let end = i + 1;
    if (reads[i]) while (end < calls.length && reads[end]) end++;
    if (end - i > 1) await runReadGroup(calls.slice(i, end));
    else await runOne(calls[i]!, i);
    i = end;
  }

  return {
    runaway,
    jobs,
    settlements,
    ...(declared ? { declared } : {}),
  };
}
