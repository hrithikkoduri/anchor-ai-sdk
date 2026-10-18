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
import { finishTool } from "../tools/finish.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
// The engine defaults to chatStrategy when none is supplied — a pragmatic
// dependency so `runAgent({ task }, { llm })` works with zero configuration.
import { chatStrategy } from "../agents/chat/strategy.js";
import type { Agent } from "../agents/types.js";
import { BudgetTracker, DEFAULT_BUDGET_LIMITS, type BudgetLimits, type BudgetExceeded } from "./budgets.js";
import { compactConversation, estimateTokens, DEFAULT_COMPACTION, type CompactionConfig } from "./compaction.js";
import { assistantMessage, toolResultMessage, userMessage } from "./context.js";
import type { AgentEvent, EventSink, RunDisposition } from "./events.js";
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
  /**
   * A built-in agent bundle (`codingAgent`, `chatAgent`) — strategy + tools
   * in one import. Explicit `strategy` / `tools` below override it per-field.
   */
  agent?: Agent;
  /** Behavior. Defaults to the agent preset's strategy, then `chatStrategy` (reply, end on the text-only turn). */
  strategy?: AgentStrategy;
  /** Where tools execute. Only needed when the strategy or tools require it. */
  sandbox?: Sandbox;
  /** Capabilities. Defaults to the agent preset's tools, then `[]`; `codingStrategy` validates its own set. */
  tools?: Tool[];
  /**
   * Engine-owned control tools, injected on top of `tools` and always
   * available: `finish` ends the run (a consumer tool with the same name is
   * ignored). Opt out per intrinsic — e.g. `{ finish: false }` for a loop
   * that must be ended by budgets alone.
   */
  intrinsics?: { finish?: boolean };
  budgets?: Partial<BudgetLimits>;
  /**
   * Context-window management. Enabled by default (thresholds in
   * DEFAULT_COMPACTION); pass `false` to disable entirely.
   */
  compaction?: CompactionConfig | false;
  /** Guardrail dials. Protections are on by default; these tune or disable individual ones. */
  guardrails?: GuardrailConfig;
  /**
   * Stop gracefully when this phase completes (before the next one begins).
   * The run returns reason "paused" with `checkpointRef` and the thread saved
   * at the next phase — resume by calling runAgent again with the same
   * thread + sandbox. The primitive behind best-of-N races and staged runs.
   */
  pauseAfterPhase?: string;
  /** Auto-checkpoint (git commit) at every phase boundary. Default true when a sandbox exists. */
  checkpoints?: boolean;
  /**
   * Force where this run starts. Overrides the thread's resume position —
   * the product uses it to resume interjected work at the phase it was
   * interrupted in (or to force a fresh start). Unknown phase → startup error.
   */
  startPhase?: string;
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

export type FinishReason =
  | "finished"
  | "max_steps"
  | "budget_exceeded"
  | "stalled"
  | "error"
  | "paused"
  | "cancelled";

export interface AgentResult {
  ok: boolean;
  summary?: string;
  reason: FinishReason;
  error?: string;
  steps: number;
  usage: LLMUsage;
  /** The full conversation — the raw material for traces. */
  messages: LLMMessage[];
  /** The last checkpoint (git commit) taken during the run — the resume/fork point. */
  checkpointRef?: string;
  /** The phase the run ended in — the product records it for resume decisions (interjections). */
  phase?: string;
  /** How a finish() concluded: "done" | "watch" | "blocked". Undefined for non-finish endings. */
  disposition?: RunDisposition;
  /** What the agent asked to be woken for (product vocabulary; the engine only carries it). */
  watch?: Record<string, unknown>;
  /** Phase a future run on this thread should start at — kept as the thread's resume position. */
  resumeAt?: string;
}

const DEFAULT_LOOP_LIMIT = 3;
const DEFAULT_NUDGE_LIMIT = 2;

export interface GuardrailConfig {
  /**
   * Block a tool call identical to the previous `limit - 1` in a row
   * (default 3; `false` disables detection entirely).
   */
  repeatedToolCallLimit?: number | false;
  /**
   * How many text-only turns a coding-shaped run tolerates before it is
   * declared stalled (default 2; `false` = never stall — budgets remain the
   * backstop). Chat-shaped strategies use `finishWhenNoToolCalls` instead.
   */
  emptyTurnNudgeLimit?: number | false;
}

export async function runAgent(task: RunTask, opts: EngineOptions): Promise<AgentResult> {
  const emit: EventSink = opts.onEvent ?? (() => undefined);
  const budgets = new BudgetTracker(opts.budgets);
  const compaction =
    opts.compaction === false
      ? null
      : { ...DEFAULT_COMPACTION, ...(typeof opts.compaction === "object" ? opts.compaction : {}) };
  const guardrails = {
    repeatedToolCallLimit: opts.guardrails?.repeatedToolCallLimit ?? DEFAULT_LOOP_LIMIT,
    emptyTurnNudgeLimit: opts.guardrails?.emptyTurnNudgeLimit ?? DEFAULT_NUDGE_LIMIT,
  };
  const strategy = opts.strategy ?? opts.agent?.strategy ?? chatStrategy;
  const suppliedTools = opts.tools ?? opts.agent?.tools ?? [];
  // Intrinsics: control tools the engine owns and injects (decision #32).
  // finish ends a run — like `return` in a language, the engine provides it;
  // consumers never list it, and a consumer tool with the same name is ignored.
  const intrinsics = opts.intrinsics ?? {};
  const tools =
    intrinsics.finish === false
      ? suppliedTools
      : [...suppliedTools.filter((t) => t.definition.name !== "finish"), finishTool];
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
  let resumePhase: string | undefined;
  if (opts.thread) {
    const prior = await opts.thread.store.load(opts.thread.id);
    priorMessages = prior?.messages ?? [];
    runningSummary = prior?.summary;
    resumePhase = prior?.phase;
  }

  // Where this run starts: an explicit startPhase wins (the product uses it to
  // resume interjected work), then the thread's saved resume position (pause
  // or crash), then the first phase.
  let phaseIndex = 0;
  if (opts.startPhase !== undefined) {
    const i = phases.findIndex((p) => p.id === opts.startPhase);
    if (i === -1) {
      throw new Error(`startPhase "${opts.startPhase}" is not a phase of strategy "${strategy.name}"`);
    }
    phaseIndex = i;
  } else if (resumePhase) {
    const i = phases.findIndex((p) => p.id === resumePhase);
    if (i >= 0) phaseIndex = i;
  }

  const messages: LLMMessage[] = [
    { role: "system", content: strategy.systemPrompt({ task: task.task, context, summary: runningSummary }) },
    ...priorMessages,
    { role: "user", content: `Begin the task. ${strategy.enterPhaseMessage(phases[phaseIndex]!)}` },
  ];

  const toolCtx: ToolContext = {
    sandbox: opts.sandbox,
    testCommand: task.testCommand,
    onFinish: () => undefined, // the engine reads finish through the tool result
  };

  let steps = 0;
  let nudges = 0;
  let phaseSteps = 0;
  let phaseNudged = false;
  let paused = false;
  let finish:
    | {
        summary: string;
        ok: boolean;
        disposition?: RunDisposition;
        watch?: Record<string, unknown>;
        resumeAt?: string;
      }
    | undefined;
  const recentSignatures: string[] = [];
  const evidence: ToolResultRecord[] = [];

  emit({ type: "run_started", task: task.task, phases: phases.map((p) => p.id) });
  emit({ type: "phase_started", phase: phases[phaseIndex]!.id });

  // Checkpointing: a git commit at every phase boundary — the resume/fork
  // points ("checkpoint after each meaningful step"). Best-effort: a failed
  // checkpoint must not kill the run; resume just degrades to the previous one.
  let lastCheckpointRef: string | undefined;
  const checkpointing = opts.checkpoints ?? true;
  const checkpointAt = async (label: string): Promise<void> => {
    if (!checkpointing || !opts.sandbox) return;
    try {
      const cp = await opts.sandbox.checkpoint(label);
      lastCheckpointRef = cp.sha;
      emit({ type: "checkpoint", ref: cp.sha, label });
    } catch {
      // swallowed — see above
    }
  };

  // Thread persistence: after every completed turn and on every exit path, so
  // a dead process loses at most the in-flight turn. Protocol-safe (never
  // between an assistant tool_calls and its results). Failures are swallowed.
  // A "watch" finish may name where the NEXT run should start; when it does,
  // the completed run leaves that as the thread's resume position instead of
  // clearing it, so any later wake (event or sweep) resumes right there.
  let declaredResumePhase: string | undefined;

  const persistThread = async (clearPhase = false): Promise<void> => {
    if (!opts.thread) return;
    const persisted = messages.filter(
      (m) =>
        m.role !== "system" &&
        !(m.role === "user" && (m.content ?? "").startsWith("Begin the task.")),
    );
    try {
      await opts.thread.store.save(opts.thread.id, {
        summary: runningSummary,
        messages: persisted,
        // The resume position survives only while there is unfinished work:
        // a crash leaves the last per-turn phase in place, a pause sets the
        // NEXT phase, and a completed run clears it — unless the agent
        // declared a "watch" with resumeAt, which keeps a pointer to where
        // the follow-up should start (same memory, fresh phases otherwise).
        phase: clearPhase ? declaredResumePhase : phases[phaseIndex]!.id,
      });
    } catch {
      // swallow: storage must not kill a run
    }
  };

  const finishWith = async (
    reason: FinishReason,
    extra: {
      ok: boolean;
      summary?: string;
      error?: string;
      disposition?: RunDisposition;
      watch?: Record<string, unknown>;
      resumeAt?: string;
    },
  ): Promise<AgentResult> => {
    const usage: LLMUsage = {
      promptTokens: budgets.promptTokens,
      completionTokens: budgets.completionTokens,
      totalTokens: budgets.totalTokens(),
      costUsd: budgets.costsKnown ? budgets.costUsd : undefined,
    };
    // Finish-shaped endings default honestly: success → "done", failure → "blocked".
    const disposition =
      extra.disposition ?? (reason === "finished" ? (extra.ok ? "done" : "blocked") : undefined);
    emit({ type: "run_finished", ok: extra.ok, summary: extra.summary, steps, usage, reason, disposition });

    // Final save. The system prompt is regenerated each run, and stale "Begin
    // the task." markers are dropped so history reads as one conversation.
    // Cleared resume position unless the run paused (unfinished work).
    await persistThread(reason !== "paused");

    return {
      ...extra,
      reason,
      steps,
      usage,
      messages,
      checkpointRef: lastCheckpointRef,
      phase: phases[phaseIndex]!.id,
    };
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

      // Cancellation is checked at every turn boundary (and again if an
      // in-flight LLM call rejects below).
      if (opts.signal?.aborted) {
        return await finishWith("cancelled", { ok: false, error: "cancelled by signal" });
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
        if (guardrails.emptyTurnNudgeLimit !== false && nudges > guardrails.emptyTurnNudgeLimit) {
          return await finishWith("stalled", {
            ok: false,
            error: "model produced no tool calls after repeated nudges",
          });
        }
        messages.push(userMessage("Continue: call a tool, or call finish(summary, success) if the task is complete."));
        await persistThread();
        continue;
      }
      nudges = 0;

      for (const call of response.toolCalls) {
        const signature = `${call.name}:${call.arguments}`;
        const loopLimit = guardrails.repeatedToolCallLimit;
        if (loopLimit !== false) {
          recentSignatures.push(signature);
          if (recentSignatures.length > loopLimit) recentSignatures.shift();
        }

        let result: ToolResult;
        if (
          loopLimit !== false &&
          recentSignatures.length === loopLimit &&
          recentSignatures.every((s) => s === signature)
        ) {
          const detail = `${call.name} called ${loopLimit}× with identical arguments — blocked`;
          emit({ type: "guardrail", kind: "loop_detected", detail });
          result = {
            ok: false,
            content:
              `Blocked by loop detection: you have called ${call.name} with these exact arguments ` +
              `${loopLimit} times. Repeating it will not change the outcome — change your approach ` +
              `(different command, or read the code again) instead.`,
          };
        } else {
          result = await dispatch(call.name, call.arguments, byName, toolCtx, emit, phase.id, steps);
        }

        const isFinish = call.name === "finish";
        // result.ok guards the tool level: a finish call that failed its own
        // argument validation is a tool error and must never end the run.
        const claimedSuccess = isFinish && result.ok && result.meta?.success !== false;
        evidence.push({ tool: call.name, ok: result.ok, meta: result.meta });

        // Strategy-enforced honesty: a success claim must be backed by evidence.
        let acceptedFinish = false;
        let finishSummary = "";
        let finishDisposition: RunDisposition | undefined;
        let finishWatch: Record<string, unknown> | undefined;
        let finishResumeAt: string | undefined;
        if (isFinish && result.ok) {
          finishSummary = typeof result.meta?.summary === "string" ? result.meta.summary : "";
          const rawDisposition = result.meta?.disposition;
          finishDisposition =
            rawDisposition === "done" || rawDisposition === "watch" || rawDisposition === "blocked"
              ? rawDisposition
              : undefined;
          const rawWatch = result.meta?.watch;
          finishWatch =
            rawWatch !== null && typeof rawWatch === "object" && !Array.isArray(rawWatch)
              ? (rawWatch as Record<string, unknown>)
              : undefined;
          finishResumeAt = typeof result.meta?.resumeAt === "string" ? result.meta.resumeAt : undefined;
          // Effective disposition: explicit first, then "watch" when a watch
          // spec is present, else done/blocked from the success claim.
          finishDisposition = finishDisposition ?? (finishWatch ? "watch" : claimedSuccess ? "done" : "blocked");

          if (finishResumeAt && !phases.some((p) => p.id === finishResumeAt)) {
            // Same class of error as an unknown startPhase — reject loudly so
            // the model can fix the value instead of poisoning the thread.
            const known = phases.map((p) => p.id).join(", ");
            emit({ type: "guardrail", kind: "finish_rejected", detail: `unknown resumeAt "${finishResumeAt}"` });
            result = {
              ok: false,
              content:
                `finish rejected: resumeAt "${finishResumeAt}" is not a phase of this strategy ` +
                `(phases: ${known}). Fix the value or drop the field.`,
            };
          } else if (claimedSuccess && strategy.validateFinish) {
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
          finish = {
            summary: finishSummary,
            ok: claimedSuccess,
            disposition: finishDisposition,
            watch: finishWatch,
            resumeAt: finishResumeAt,
          };
          if (finishDisposition === "watch" && finishResumeAt) declaredResumePhase = finishResumeAt;
          break;
        }

        if (phases[phaseIndex]!.advanceOn?.(result, call.name)) {
          const finishedPhase = phases[phaseIndex]!;
          // The boundary is the meaningful step — checkpoint before crossing it.
          await checkpointAt(`after ${finishedPhase.id}`);
          phaseIndex = Math.min(phaseIndex + 1, phases.length - 1);
          phaseSteps = 0;
          phaseNudged = false;
          if (opts.pauseAfterPhase === finishedPhase.id) {
            // Pause AT the boundary: the next run resumes in the new phase
            // (persisted via the thread) and injects its entry message there.
            paused = true;
            break;
          }
          const entered = phases[phaseIndex]!;
          emit({ type: "phase_started", phase: entered.id });
          messages.push(userMessage(strategy.enterPhaseMessage(entered)));
        }
      }

      if (paused) break;

      // Crash-safety: persist after every completed turn.
      await persistThread();

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

    if (paused) {
      return await finishWith("paused", {
        ok: false,
        summary: `paused after a phase boundary — next phase: ${phases[phaseIndex]!.id}`,
      });
    }

    return await finishWith("finished", {
      ok: finish?.ok ?? false,
      summary: finish?.summary,
      disposition: finish?.disposition,
      watch: finish?.watch,
      resumeAt: finish?.resumeAt,
    });
  } catch (err) {
    // An abort is a decision, not a failure — report it as such.
    if (opts.signal?.aborted) {
      return await finishWith("cancelled", { ok: false, error: "cancelled by signal" });
    }
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
