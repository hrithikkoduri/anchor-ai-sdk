/**
 * Tool-call dispatch: the two shapes a model turn can take.
 *
 * A turn whose calls are ALL read-only runs them in parallel (one round trip
 * instead of N); anything else runs serially in the model's order, so a
 * `finish` or a pause is observed before later calls. Both paths reuse the
 * same repetition tracker and emit the same events, which is why they live
 * together: splitting them is how they drift.
 */
import { toPlainJsonObject } from "../json.js";
import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import type { Tool } from "../tools/types.js";
import type { ToolContext } from "../tools/types.js";
import type { ToolResult } from "../tools/types.js";
import { toolVerb } from "../tools/activity.js";
import { boundToolResult, TOOL_RESULT_MAX_CHARS } from "../tools/truncate.js";
import { toolResultMessage } from "./context.js";
import type { EventSink } from "./events.js";
import type { ToolResultRecord } from "./strategy.js";
import type { RepeatTracker } from "./guardrails.js";
import type { BackgroundJob } from "./types.js";

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
  phase: string;
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

/**
 * Execute a turn's tool calls and emit their results.
 *
 * Returns the repetition verdict and, when `finish` ran, what it declared.
 */
export async function dispatchToolCalls(
  args: ToolDispatchArgs,
): Promise<ToolDispatchOutcome> {
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

  const parallelReads =
    calls.length > 1 &&
    calls.every((call) => {
      const tool = available.get(call.name);
      // An effectful call journals before it runs; keep that serial and ordered.
      return tool?.readOnly === true && tool.effect === undefined;
    }) &&
    !declared &&
    !args.pauseRequested() &&
    !signal?.aborted;

  const emitResult = (
    call: LLMToolCall,
    verb: string | undefined,
    result: ToolResult,
    operationId?: string,
  ): void => {
    args.onToolResult?.(call, result);
    evidence.push({ tool: call.name, ok: result.ok, meta: result.meta });
    emit({
      type: "tool_result",
      name: call.name,
      callId: call.id,
      ...(operationId ? { operationId } : {}),
      verb: result.verb ?? verb,
      phase,
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

  if (parallelReads) {
    const prepared = calls.map((call) => {
      const tool = available.get(call.name);
      const { input, invalid } = parseInput(call);
      const verb = toolVerb(call.name, input, tool?.verb);
      emit({
        type: "tool_call",
        name: call.name,
        callId: call.id,
        input,
        verb,
        phase,
        step: steps,
      });
      if (repeat.record(`${call.name}:${call.arguments}`)) runaway = true;
      return { call, tool, input, invalid, verb, skipped: runaway };
    });

    const results = await Promise.all(
      prepared.map(
        async ({ call, tool, input, invalid, skipped }): Promise<ToolResult> => {
          if (skipped) {
            return {
              ok: false,
              content:
                "Not executed: repeated identical calls reached the loop limit.",
            };
          }
          if (invalid)
            return {
              ok: false,
              content: invalid,
            };
          const outcome = await invoke(
            tool,
            call.name,
            input,
            { ...toolContext, callId: call.id },
            available,
          );
          return "invalid" in outcome
            ? { ok: false, content: outcome.invalid }
            : outcome.result;
        },
      ),
    );

    for (let i = 0; i < prepared.length; i++) {
      const { call, verb } = prepared[i]!;
      emitResult(call, verb, results[i]!);
    }
    return { runaway, jobs, settlements, ...(declared ? { declared } : {}) };
  }

  // Resource-grouped mutation path. Only non-effect mutations with distinct
  // repository keys are eligible; anything global/effectful/finish falls back
  // to the fully ordered path below. Results are still emitted in call order.
  if (calls.length > 1 && !declared && !args.pauseRequested() && !signal?.aborted) {
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
          phase,
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
              { ...toolContext, callId: item.call.id },
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

  for (const call of calls) {
    const tool = available.get(call.name);
    const { input, invalid } = parseInput(call);
    const verb = toolVerb(call.name, input, tool?.verb);
    if (repeat.record(`${call.name}:${call.arguments}`)) runaway = true;
    const skipped =
      declared !== undefined ||
      args.pauseRequested() ||
      signal?.aborted === true ||
      runaway;

    // Write-ahead: an effectful call records its intent BEFORE it runs, so a
    // crash between the target's write and our result leaves a pending record
    // instead of a silent replay. A journal failure fails closed.
    let operationId: string | undefined;
    let operationStarted = false;
    let operationError: string | undefined;
    if (!skipped && invalid === undefined && tool?.effect) {
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
      input,
      verb,
      phase,
      step: steps,
    });

    let result: ToolResult;
    if (skipped) {
      result = {
        ok: false,
        content: declared
          ? "Not executed: the turn was already concluded."
          : args.pauseRequested()
            ? "Not executed: the caller requested a pause at this phase boundary."
            : signal?.aborted
              ? "Not executed: cancelled by signal."
              : "Not executed: repeated identical calls reached the loop limit.",
      };
    } else if (operationError) {
      result = { ok: false, content: operationError };
    } else if (invalid) {
      result = { ok: false, content: invalid };
    } else {
      const callContext: ToolContext = {
        ...toolContext,
        callId: call.id,
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
    emitResult(call, verb, result, operationId);
  }

  return {
    runaway,
    jobs,
    settlements,
    ...(declared ? { declared } : {}),
  };
}
