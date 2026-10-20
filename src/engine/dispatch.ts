/**
 * Tool-call dispatch: the two shapes a model turn can take.
 *
 * A turn whose calls are ALL read-only runs them in parallel (one round trip
 * instead of N); anything else runs serially in the model's order, so a
 * `finish` or a pause is observed before later calls. Both paths reuse the
 * same repetition tracker and emit the same events, which is why they live
 * together: splitting them is how they drift.
 */
import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import type { Tool } from "../tools/types.js";
import type { ToolContext } from "../tools/types.js";
import type { ToolResult } from "../tools/types.js";
import { toolVerb } from "../tools/activity.js";
import { toolResultMessage } from "./context.js";
import type { EventSink } from "./events.js";
import type { ToolResultRecord } from "./strategy.js";
import type { RepeatTracker } from "./guardrails.js";

/** What `finish` declared, if the turn called it. */
export interface DeclaredOutcome {
  ok: boolean;
  summary: string;
  handoff?: Record<string, unknown>;
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
  signal?: AbortSignal;
  /** Read live: a `pause` tool sets it during this very dispatch. */
  pauseRequested: () => boolean;
}

export interface ToolDispatchOutcome {
  /** The repetition limit was hit; the caller decides whether to nudge. */
  runaway: boolean;
  declared?: DeclaredOutcome;
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
    return { result: await tool.run(input, ctx) };
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

  const parallelReads =
    calls.length > 1 &&
    calls.every((call) => available.get(call.name)?.readOnly === true) &&
    !declared &&
    !args.pauseRequested() &&
    !signal?.aborted;

  const emitResult = (
    call: LLMToolCall,
    verb: string | undefined,
    result: ToolResult,
  ): void => {
    evidence.push({ tool: call.name, ok: result.ok, meta: result.meta });
    emit({
      type: "tool_result",
      name: call.name,
      callId: call.id,
      verb: result.verb ?? verb,
      phase,
      step: steps,
      ok: result.ok,
      content: result.content,
      contentChars: result.content.length,
      meta: result.meta,
    });
    messages.push(toolResultMessage(call.id, result.content));
    emitBackground(call.name, call.id, result);
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
          const outcome = await invoke(tool, call.name, input, toolContext, available);
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
    return { runaway, ...(declared ? { declared } : {}) };
  }

  for (const call of calls) {
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

    let result: ToolResult;
    if (declared || args.pauseRequested() || signal?.aborted || runaway) {
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
    } else if (invalid) {
      result = { ok: false, content: invalid };
    } else {
      const outcome = await invoke(tool, call.name, input, toolContext, available);
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
    emitResult(call, verb, result);
  }

  return { runaway, ...(declared ? { declared } : {}) };
}
