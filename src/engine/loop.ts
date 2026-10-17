/**
 * The engine — the agent loop, strategy-agnostic.
 *
 * while not finished:
 *   check budgets → ask the LLM (streamed) → echo the assistant turn →
 *   dispatch tool calls (with guardrails) → feed results back → let the
 *   strategy advance phases on evidence → repeat until finish()/limits.
 *
 * Everything hard about an agent lives here or below (sandbox, tools, llm);
 * nothing about *this product* does. The engine talks only to interfaces.
 *
 * Guardrails in this file:
 *   - budgets (steps/tokens/$) checked before every turn
 *   - loop detection: the same tool + arguments 3× in a row is blocked with
 *     an explanation instead of being executed again
 *   - protocol discipline: a turn with no tool calls gets nudged (twice)
 *     before the run is declared stalled
 */
import type { LLMClient, LLMMessage, LLMToolDef, LLMUsage } from "../llm/types.js";
import type { Sandbox } from "../sandbox/types.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { BudgetTracker, DEFAULT_BUDGET_LIMITS, type BudgetLimits, type BudgetExceeded } from "./budgets.js";
import { assistantMessage, toolResultMessage, userMessage } from "./context.js";
import type { AgentEvent, EventSink } from "./events.js";
import type { AgentStrategy } from "./strategy.js";

export interface RunTask {
  /** The task statement (issue text). */
  task: string;
  /** Extra context for the system prompt (e.g. the repo map). */
  context?: string;
  /** Default test command for the run_tests tool. */
  testCommand?: string;
}

export interface EngineOptions {
  llm: LLMClient;
  sandbox: Sandbox;
  tools: Tool[];
  strategy: AgentStrategy;
  budgets?: Partial<BudgetLimits>;
  onEvent?: EventSink;
  signal?: AbortSignal;
}

export type FinishReason = "finished" | "max_steps" | "budget_exceeded" | "stalled" | "error";

export interface AgentResult {
  ok: boolean;
  summary?: string;
  reason: FinishReason;
  error?: string;
  steps: number;
  usage: LLMUsage;
  /** The full conversation — the raw material for traces. */
  messages: LLMMessage[];
}

const NUDGE_LIMIT = 2;
const LOOP_THRESHOLD = 3;

export async function runAgent(task: RunTask, opts: EngineOptions): Promise<AgentResult> {
  const emit: EventSink = opts.onEvent ?? (() => undefined);
  const budgets = new BudgetTracker(opts.budgets);
  const byName = new Map(opts.tools.map((t) => [t.definition.name, t] as const));
  const toolDefs: LLMToolDef[] = opts.tools.map((t) => ({ type: "function", function: t.definition }));

  const phases = opts.strategy.phases;
  if (phases.length === 0) throw new Error("strategy has no phases");

  const messages: LLMMessage[] = [
    { role: "system", content: opts.strategy.systemPrompt({ task: task.task, context: task.context }) },
    { role: "user", content: `Begin the task. ${opts.strategy.enterPhaseMessage(phases[0]!)}` },
  ];

  const toolCtx: ToolContext = {
    sandbox: opts.sandbox,
    testCommand: task.testCommand,
    onFinish: () => undefined, // the engine reads finish through the tool result
  };

  let phaseIndex = 0;
  let steps = 0;
  let nudges = 0;
  let finish: { summary: string; ok: boolean } | undefined;
  const recentSignatures: string[] = [];

  emit({ type: "run_started", task: task.task, phases: phases.map((p) => p.id) });
  emit({ type: "phase_started", phase: phases[0]!.id });

  const finishWith = (reason: FinishReason, extra: { ok: boolean; summary?: string; error?: string }): AgentResult => {
    const usage: LLMUsage = {
      promptTokens: budgets.promptTokens,
      completionTokens: budgets.completionTokens,
      totalTokens: budgets.totalTokens(),
      costUsd: budgets.costsKnown ? budgets.costUsd : undefined,
    };
    emit({ type: "run_finished", ok: extra.ok, summary: extra.summary, steps, usage, reason });
    return { ...extra, reason, steps, usage, messages };
  };

  try {
    for (;;) {
      if (finish) break;

      const over: BudgetExceeded | null = budgets.exceeded(steps);
      if (over) {
        emit({ type: "guardrail", kind: "budget_exceeded", detail: over.detail });
        return finishWith(over.kind === "steps" ? "max_steps" : "budget_exceeded", {
          ok: false,
          error: over.detail,
        });
      }

      steps += 1;
      const phase = phases[phaseIndex]!;
      emit({ type: "llm_call_started", phase: phase.id, step: steps });

      const response = await opts.llm.stream(
        { messages, tools: toolDefs },
        (delta) => emit({ type: "llm_text_delta", text: delta }),
        { signal: opts.signal },
      );

      budgets.record(response.usage);
      emit({
        type: "llm_call_finished",
        phase: phase.id,
        step: steps,
        textChars: response.text.length,
        toolCalls: response.toolCalls.length,
        usage: response.usage,
        latencyMs: response.latencyMs,
      });

      messages.push(assistantMessage(response));

      if (response.toolCalls.length === 0) {
        nudges += 1;
        if (nudges > NUDGE_LIMIT) {
          return finishWith("stalled", {
            ok: false,
            error: "model produced no tool calls after repeated nudges",
          });
        }
        messages.push(userMessage("Continue: call a tool, or call finish(summary, success) if the task is complete."));
        continue;
      }
      nudges = 0;

      for (const call of response.toolCalls) {
        const signature = `${call.name}:${call.arguments}`;
        recentSignatures.push(signature);
        if (recentSignatures.length > LOOP_THRESHOLD) recentSignatures.shift();

        let result: ToolResult;
        if (
          recentSignatures.length === LOOP_THRESHOLD &&
          recentSignatures.every((s) => s === signature)
        ) {
          const detail = `${call.name} called ${LOOP_THRESHOLD}× with identical arguments — blocked`;
          emit({ type: "guardrail", kind: "loop_detected", detail });
          result = {
            ok: false,
            content:
              `Blocked by loop detection: you have called ${call.name} with these exact arguments ` +
              `${LOOP_THRESHOLD} times. Repeating it will not change the outcome — change your approach ` +
              `(different command, or read the code again) instead.`,
          };
        } else {
          result = await dispatch(call.name, call.arguments, byName, toolCtx, emit, phase.id, steps);
        }

        emit({
          type: "tool_result",
          phase: phase.id,
          step: steps,
          name: call.name,
          ok: result.ok,
          contentChars: result.content.length,
          meta: result.meta,
        });
        messages.push(toolResultMessage(call.id, result.content));

        if (call.name === "finish") {
          finish = {
            summary: typeof result.meta?.summary === "string" ? result.meta.summary : "",
            ok: result.meta?.success !== false,
          };
          break;
        }

        if (phases[phaseIndex]!.advanceOn?.(result, call.name)) {
          phaseIndex = Math.min(phaseIndex + 1, phases.length - 1);
          const entered = phases[phaseIndex]!;
          emit({ type: "phase_started", phase: entered.id });
          messages.push(userMessage(opts.strategy.enterPhaseMessage(entered)));
        }
      }
    }

    return finishWith("finished", { ok: finish?.ok ?? false, summary: finish?.summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message });
    return finishWith("error", { ok: false, error: message });
  }
}

async function dispatch(
  name: string,
  rawArguments: string,
  byName: Map<string, Tool>,
  toolCtx: ToolContext,
  emit: EventSink,
  phase: string,
  step: number,
): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool) {
    return {
      ok: false,
      content: `unknown tool "${name}" — available: ${[...byName.keys()].join(", ")}`,
    };
  }
  let input: Record<string, unknown>;
  try {
    input = rawArguments.trim() === "" ? {} : (JSON.parse(rawArguments) as Record<string, unknown>);
  } catch (err) {
    return {
      ok: false,
      content: `tool arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  emit({ type: "tool_call", phase, step, name, input });
  return tool.run(input, toolCtx);
}
