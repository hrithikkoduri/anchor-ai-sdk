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
// The engine defaults to chatStrategy when none is supplied — a pragmatic
// dependency so `runAgent({ task }, { llm })` works with zero configuration.
import { chatStrategy } from "../strategies/chat.js";
import { BudgetTracker, DEFAULT_BUDGET_LIMITS, type BudgetLimits, type BudgetExceeded } from "./budgets.js";
import { compactConversation, estimateTokens, DEFAULT_COMPACTION, type CompactionConfig } from "./compaction.js";
import { assistantMessage, toolResultMessage, userMessage } from "./context.js";
import type { AgentEvent, EventSink } from "./events.js";
import type { ThreadStore } from "./thread.js";
import type { AgentStrategy, ToolResultRecord } from "./strategy.js";

export interface RunTask {
  /** The task statement (issue text). */
  task: string;
  /** Extra context for the system prompt (e.g. the repo map). */
  context?: string;
  /** Default test command for the run_tests tool. */
  testCommand?: string;
}

export interface EngineOptions {
  /** The model transport — the only required piece. */
  llm: LLMClient;
  /** Behavior. Defaults to `chatStrategy` (reply, end on the text-only turn). */
  strategy?: AgentStrategy;
  /** Where tools execute. Only needed when the strategy or tools require it. */
  sandbox?: Sandbox;
  /** Capabilities. Defaults to `[]`; `codingStrategy` validates its own set. */
  tools?: Tool[];
  budgets?: Partial<BudgetLimits>;
  /**
   * Context-window management. Enabled by default (thresholds in
   * DEFAULT_COMPACTION); pass `false` to disable entirely.
   */
  compaction?: CompactionConfig | false;
  onEvent?: EventSink;
  signal?: AbortSignal;
  /**
   * Cross-run memory (threads). When supplied, the engine loads the prior
   * conversation before the first LLM call and saves the updated one when the
   * run ends — this is what makes multi-turn agents (chat, issue→PR, …)
   * possible. Prefer `MemoryThreadStore` for tests and a durable `ThreadStore`
   * implementation in products.
   */
  thread?: { store: ThreadStore; id: string };
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
  const compaction =
    opts.compaction === false
      ? null
      : { ...DEFAULT_COMPACTION, ...(typeof opts.compaction === "object" ? opts.compaction : {}) };
  const strategy = opts.strategy ?? chatStrategy;
  const tools = opts.tools ?? [];
  const byName = new Map(tools.map((t) => [t.definition.name, t] as const));
  const toolDefs: LLMToolDef[] = tools.map((t) => ({ type: "function", function: t.definition }));

  const phases = strategy.phases;
  if (phases.length === 0) throw new Error("strategy has no phases");

  // A strategy/tool/sandbox mismatch must fail here, not confuse the model mid-run.
  const missing = (strategy.requiredTools ?? []).filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`strategy "${strategy.name}" requires tools that were not supplied: ${missing.join(", ")}`);
  }
  if (strategy.requiresSandbox && !opts.sandbox) {
    throw new Error(`strategy "${strategy.name}" requires a sandbox — pass EngineOptions.sandbox`);
  }

  // Orientation (repo map etc.): explicit task context wins; otherwise the
  // strategy may prepare it against the sandbox (undefined for sandbox-free).
  const context =
    task.context ?? (strategy.prepareContext ? await strategy.prepareContext(opts.sandbox, task.task) : undefined);

  // Cross-run memory: prior turns load here, the updated conversation saves
  // in finishWith (every exit path).
  let priorMessages: LLMMessage[] = [];
  let runningSummary: string | undefined;
  if (opts.thread) {
    const prior = await opts.thread.store.load(opts.thread.id);
    priorMessages = prior?.messages ?? [];
    runningSummary = prior?.summary;
  }

  const messages: LLMMessage[] = [
    { role: "system", content: strategy.systemPrompt({ task: task.task, context, summary: runningSummary }) },
    ...priorMessages,
    { role: "user", content: `Begin the task. ${strategy.enterPhaseMessage(phases[0]!)}` },
  ];

  const toolCtx: ToolContext = {
    sandbox: opts.sandbox,
    testCommand: task.testCommand,
    onFinish: () => undefined, // the engine reads finish through the tool result
  };

  let phaseIndex = 0;
  let steps = 0;
  let nudges = 0;
  let phaseSteps = 0;
  let phaseNudged = false;
  let finish: { summary: string; ok: boolean } | undefined;
  const recentSignatures: string[] = [];
  const evidence: ToolResultRecord[] = [];

  emit({ type: "run_started", task: task.task, phases: phases.map((p) => p.id) });
  emit({ type: "phase_started", phase: phases[0]!.id });

  const finishWith = async (
    reason: FinishReason,
    extra: { ok: boolean; summary?: string; error?: string },
  ): Promise<AgentResult> => {
    const usage: LLMUsage = {
      promptTokens: budgets.promptTokens,
      completionTokens: budgets.completionTokens,
      totalTokens: budgets.totalTokens(),
      costUsd: budgets.costsKnown ? budgets.costUsd : undefined,
    };
    emit({ type: "run_finished", ok: extra.ok, summary: extra.summary, steps, usage, reason });

    // Persist the conversation for the next run. The system prompt is
    // regenerated each run, and stale "Begin the task." markers are dropped so
    // history reads as one continuous conversation. Storage failures must not
    // kill a finished run.
    if (opts.thread) {
      const persisted = messages.filter(
        (m) =>
          m.role !== "system" &&
          !(m.role === "user" && (m.content ?? "").startsWith("Begin the task.")),
      );
      try {
        await opts.thread.store.save(opts.thread.id, { summary: runningSummary, messages: persisted });
      } catch {
        // swallow: a finished run is still finished
      }
    }

    return { ...extra, reason, steps, usage, messages };
  };

  try {
    for (;;) {
      if (finish) break;

      const over: BudgetExceeded | null = budgets.exceeded(steps);
      if (over) {
        emit({ type: "guardrail", kind: "budget_exceeded", detail: over.detail });
        return await finishWith(over.kind === "steps" ? "max_steps" : "budget_exceeded", {
          ok: false,
          error: over.detail,
        });
      }

      // Context-window management: fold the oldest span into the running
      // summary before the conversation grows past what the model can take.
      if (compaction && estimateTokens(messages) > compaction.maxEstimatedTokens) {
        const outcome = await compactConversation({
          llm: opts.llm,
          messages,
          runningSummary,
          keepRecentTokens: compaction.keepRecentTokens,
          signal: opts.signal,
        });
        if (outcome) {
          budgets.record(outcome.usage); // compaction costs money; budgets see it
          runningSummary = outcome.summary;
          const system = strategy.systemPrompt({ task: task.task, context, summary: runningSummary });
          const anchor = userMessage(
            `${strategy.enterPhaseMessage(phases[phaseIndex]!)} (Conversation compacted — continue from the summary in the system prompt.)`,
          );
          messages.splice(0, messages.length, { role: "system", content: system }, anchor, ...outcome.keptMessages);
          emit({
            type: "compacted",
            removedMessages: outcome.removedCount,
            keptMessages: outcome.keptMessages.length,
            summaryChars: outcome.summary.length,
            usage: outcome.usage,
          });
        }
      }

      steps += 1;
      phaseSteps += 1;
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
        text: response.text,
        toolCalls: response.toolCalls,
        textChars: response.text.length,
        toolCallsCount: response.toolCalls.length,
        usage: response.usage,
        latencyMs: response.latencyMs,
      });

      messages.push(assistantMessage(response));

      if (response.toolCalls.length === 0) {
        // Chat-shaped strategies end a run on a text-only turn — that IS the
        // reply. Coding-shaped strategies nudge instead: they expect work.
        if (strategy.finishWhenNoToolCalls) {
          finish = { summary: response.text.trim(), ok: true };
          break;
        }
        nudges += 1;
        if (nudges > NUDGE_LIMIT) {
          return await finishWith("stalled", {
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

        const isFinish = call.name === "finish";
        const claimedSuccess = isFinish && result.meta?.success !== false;
        evidence.push({ tool: call.name, ok: result.ok, meta: result.meta });

        // Strategy-enforced honesty: a success claim must be backed by evidence.
        let acceptedFinish = false;
        let finishSummary = "";
        if (isFinish) {
          finishSummary = typeof result.meta?.summary === "string" ? result.meta.summary : "";
          if (claimedSuccess && strategy.validateFinish) {
            const verdict = strategy.validateFinish(evidence);
            if (verdict.allow) {
              acceptedFinish = true;
            } else {
              const reason = verdict.reason ?? "the required evidence is missing";
              emit({ type: "guardrail", kind: "finish_rejected", detail: reason });
              result = {
                ok: false,
                content:
                  `finish(success=true) rejected: ${reason}. Keep working — ` +
                  `or, if you are genuinely blocked, call finish(summary, success=false).`,
              };
            }
          } else {
            acceptedFinish = true; // success=false finishes are always accepted
          }
        }

        emit({
          type: "tool_result",
          phase: phase.id,
          step: steps,
          name: call.name,
          ok: result.ok,
          content: result.content,
          contentChars: result.content.length,
          meta: result.meta,
        });
        messages.push(toolResultMessage(call.id, result.content));

        if (isFinish && acceptedFinish) {
          finish = { summary: finishSummary, ok: claimedSuccess };
          break;
        }

        if (phases[phaseIndex]!.advanceOn?.(result, call.name)) {
          phaseIndex = Math.min(phaseIndex + 1, phases.length - 1);
          phaseSteps = 0;
          phaseNudged = false;
          const entered = phases[phaseIndex]!;
          emit({ type: "phase_started", phase: entered.id });
          messages.push(userMessage(strategy.enterPhaseMessage(entered)));
        }
      }

      // Soft per-phase budget: nudge once when a phase overstays its welcome,
      // so "this cannot be reproduced" ends with a falsified finish instead of
      // a burned-out global budget.
      const currentPhase = phases[phaseIndex]!;
      if (currentPhase.maxSteps && phaseSteps > currentPhase.maxSteps && !phaseNudged) {
        phaseNudged = true;
        messages.push(
          userMessage(
            `You have spent ${phaseSteps} turns in the "${currentPhase.id}" phase (soft limit ` +
              `${currentPhase.maxSteps}). If you cannot ${currentPhase.goal}, call ` +
              `finish(summary, success=false) explaining what you learned.`,
          ),
        );
      }
    }

    return await finishWith("finished", { ok: finish?.ok ?? false, summary: finish?.summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message });
    return await finishWith("error", { ok: false, error: message });
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
