/**
 * The default agent runtime: model → authorized tools → observations → model.
 * A normal final response ends the turn. It is not a test certificate, a task
 * completion claim, or permission to publish. Phases are agent-controlled
 * descriptions of the approach, not a second gated execution engine.
 */
import type { LLMMessage } from "../llm/types.js";
import type { ToolResult } from "../tools/types.js";
import { finishTool } from "../tools/finish.js";
import { toolVerb } from "../tools/activity.js";
import { chatStrategy } from "../agents/chat/strategy.js";
import { BudgetTracker } from "./budgets.js";
import {
  compactConversation,
  DEFAULT_COMPACTION,
  estimateTokens,
} from "./compaction.js";
import {
  assistantMessage,
  conversationHistory,
  toolResultMessage,
  userMessage,
} from "./context.js";
import type { ToolResultRecord } from "./strategy.js";
import { defineTool } from "../tools/types.js";
import type {
  RunTask,
  EngineOptions,
  AgentResult,
  FinishReason,
} from "./types.js";

export type {
  RunTask,
  EngineOptions,
  AgentResult,
  FinishReason,
  GuardrailConfig,
} from "./types.js";

export async function runAgent(
  task: RunTask,
  opts: EngineOptions,
): Promise<AgentResult> {
  const strategy = opts.strategy ?? opts.agent?.strategy ?? chatStrategy;
  const emit = opts.onEvent ?? (() => undefined);
  const tools = opts.tools ?? opts.agent?.tools ?? [];
  const available = new Map(tools.map((tool) => [tool.definition.name, tool]));
  // Optional structured handoff (watch/blocked), never required to stop.
  if (opts.intrinsics?.finish !== false) available.set("finish", finishTool);
  const missing = (strategy.requiredTools ?? []).filter(
    (name) => !available.has(name),
  );
  if (missing.length)
    throw new Error(
      `strategy "${strategy.name}" requires tools that were not supplied: ${missing.join(", ")}`,
    );
  if (strategy.requiresSandbox && !opts.sandbox)
    throw new Error(
      `strategy "${strategy.name}" requires a sandbox — pass EngineOptions.sandbox`,
    );
  let phase = opts.startPhase ?? strategy.phases[0]?.id ?? "respond";
  if (
    opts.startPhase &&
    !strategy.phases.some((p) => p.id === opts.startPhase)
  ) {
    throw new Error(
      `startPhase "${opts.startPhase}" is not a phase of strategy "${strategy.name}"`,
    );
  }
  const context =
    task.context ?? (await strategy.prepareContext?.(opts.sandbox, task.task));
  const prior = await opts.thread?.store.load(opts.thread.id);
  if (
    !opts.startPhase &&
    prior?.phase &&
    strategy.phases.some((item) => item.id === prior.phase)
  )
    phase = prior.phase;
  let summary = prior?.summary;
  const currentRequest = userMessage(task.task);
  const system = () => ({
    role: "system" as const,
    content: strategy.systemPrompt({ task: task.task, context, summary }),
  });
  const messages: LLMMessage[] = [
    system(),
    ...conversationHistory(prior?.messages ?? []),
    currentRequest,
  ];
  const budget = new BudgetTracker(opts.budgets);
  const compact =
    opts.compaction === false
      ? null
      : { ...DEFAULT_COMPACTION, ...opts.compaction };
  const evidence: ToolResultRecord[] = [];
  const signatures: string[] = [];
  const repeatLimit = opts.guardrails?.repeatedToolCallLimit ?? 3;
  let steps = 0;
  let checkpointRef: string | undefined;
  let pauseRequested = false;
  if (strategy.phases.length > 1 && opts.intrinsics?.phase !== false) {
    available.set(
      "set_phase",
      defineTool(
        {
          name: "set_phase",
          description:
            "Describe the current phase of your approach. You may skip phases or revisit an earlier one. This records progress; it does not authorize actions or require tests. You can finish a response from any phase without calling this tool.",
          parameters: {
            type: "object",
            properties: {
              phase: {
                type: "string",
                enum: strategy.phases.map((item) => item.id),
              },
              reason: {
                type: "string",
                description:
                  "Brief reason this phase fits the current approach.",
              },
            },
            required: ["phase"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const target = strategy.phases.find(
            (item) => item.id === input.phase,
          );
          if (!target)
            return {
              ok: false,
              content: `Unknown phase. Available: ${strategy.phases.map((item) => item.id).join(", ")}. This is a progress label, not a completion requirement.`,
            };
          const previous = phase;
          phase = target.id;
          pauseRequested =
            opts.pauseAfterPhase === previous && previous !== phase;
          emit({ type: "phase_started", phase });
          return {
            ok: true,
            content: `Current approach: ${target.id} — ${target.goal}`,
            meta: { phase, previous, reason: input.reason },
          };
        },
        { verb: (input) => `Moving into the ${String(input.phase)} phase` },
      ),
    );
  }

  const persist = async (done = false, resumeAt?: string) => {
    try {
      await opts.thread?.store.save(opts.thread.id, {
        summary,
        messages: conversationHistory(messages),
        phase: done ? resumeAt : phase,
      });
    } catch {
      /* a storage outage must not corrupt the model/tool protocol */
    }
  };
  const conclude = async (
    reason: FinishReason,
    extra: {
      ok: boolean;
      summary?: string;
      error?: string;
      disposition?: "done" | "watch" | "blocked";
      watch?: Record<string, unknown>;
      resumeAt?: string;
      completion?: "response" | "declared";
    },
  ): Promise<AgentResult> => {
    // Snapshots are a persistence concern, not a phase the model must enter.
    // Avoid empty commits, especially for reviews and simple conversation.
    if (opts.sandbox && opts.checkpoints !== false) {
      try {
        if (await opts.sandbox.hasChangesFrom("HEAD")) {
          const cp = await opts.sandbox.checkpoint("agent turn checkpoint");
          checkpointRef = cp.sha;
          emit({ type: "checkpoint", ref: cp.sha, label: "turn boundary" });
        }
      } catch {
        /* best-effort snapshot; never a reason to keep reasoning */
      }
    }
    const usage = {
      promptTokens: budget.promptTokens,
      completionTokens: budget.completionTokens,
      totalTokens: budget.totalTokens(),
      costUsd: budget.costsKnown ? budget.costUsd : undefined,
      ...(budget.reasoningTokens !== undefined
        ? { reasoningTokens: budget.reasoningTokens }
        : {}),
    };
    emit({
      type: "run_finished",
      ok: extra.ok,
      summary: extra.summary,
      steps,
      usage,
      reason,
      disposition: extra.disposition,
    });
    await persist(
      reason !== "paused",
      extra.disposition === "watch" ? extra.resumeAt : undefined,
    );
    return {
      ...extra,
      reason,
      steps,
      usage,
      messages,
      checkpointRef,
      phase,
      evidence,
    };
  };

  emit({
    type: "run_started",
    task: task.task,
    phases: strategy.phases.map((item) => item.id),
  });
  emit({ type: "phase_started", phase });
  try {
    for (;;) {
      if (opts.signal?.aborted)
        return conclude("cancelled", {
          ok: false,
          error: "cancelled by signal",
        });
      const over = budget.exceeded(steps);
      if (over) {
        emit({
          type: "guardrail",
          kind: "budget_exceeded",
          detail: over.detail,
        });
        return conclude(
          over.kind === "steps" ? "max_steps" : "budget_exceeded",
          { ok: false, error: over.detail },
        );
      }
      if (compact && estimateTokens(messages) > compact.maxEstimatedTokens) {
        const folded = await compactConversation({
          llm: opts.llm,
          messages,
          runningSummary: summary,
          keepRecentTokens: compact.keepRecentTokens,
          signal: opts.signal,
        });
        if (folded) {
          budget.record(folded.usage);
          summary = folded.summary;
          const tail = folded.keptMessages;
          // Preserve the actual current request even if its earlier position
          // was folded. Do not replace it with a generic "Begin" instruction.
          messages.splice(
            0,
            messages.length,
            system(),
            ...(tail.includes(currentRequest) ? [] : [currentRequest]),
            ...tail,
          );
          emit({
            type: "compacted",
            removedMessages: folded.removedCount,
            keptMessages: tail.length,
            summaryChars: summary.length,
            usage: folded.usage,
          });
          // Compaction itself consumes budget; check again before inference.
          const after = budget.exceeded(steps);
          if (after)
            return conclude("budget_exceeded", {
              ok: false,
              error: after.detail,
            });
        }
      }
      steps++;
      emit({ type: "llm_call_started", phase, step: steps });
      const response = await opts.llm.stream(
        {
          messages,
          tools: [...available.values()].map((tool) => ({
            type: "function",
            function: tool.definition,
          })),
        },
        (text) => emit({ type: "llm_text_delta", text }),
        {
          signal: opts.signal,
          onReasoning: (text) => emit({ type: "llm_reasoning_delta", text }),
        },
      );
      budget.record(response.usage);
      emit({
        type: "llm_call_finished",
        phase,
        step: steps,
        text: response.text,
        reasoning: response.reasoning,
        toolCalls: response.toolCalls,
        textChars: response.text.length,
        toolCallsCount: response.toolCalls.length,
        usage: response.usage,
        latencyMs: response.latencyMs,
      });
      messages.push(assistantMessage(response));
      if (!response.toolCalls.length) {
        if (!response.text.trim())
          return conclude("stalled", {
            ok: false,
            error: "model returned neither text nor tool calls",
          });
        return conclude("finished", {
          ok: true,
          summary: response.text.trim(),
          completion: "response",
        });
      }

      let declared:
        | {
            ok: boolean;
            summary: string;
            disposition: "done" | "watch" | "blocked";
            watch?: Record<string, unknown>;
            resumeAt?: string;
          }
        | undefined;
      let runaway = false;
      for (const call of response.toolCalls) {
        const tool = available.get(call.name);
        let input: Record<string, unknown> = {};
        let invalid: string | undefined;
        try {
          const parsed: unknown = call.arguments.trim()
            ? JSON.parse(call.arguments)
            : {};
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("expected a JSON object");
          input = parsed as Record<string, unknown>;
        } catch (err) {
          invalid = `tool arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
        }
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
        const signature = `${call.name}:${call.arguments}`;
        if (repeatLimit !== false) {
          signatures.push(signature);
          if (signatures.length > repeatLimit) signatures.shift();
          runaway ||=
            signatures.length === repeatLimit &&
            signatures.every((value) => value === signature);
        }
        let result: ToolResult;
        if (declared || pauseRequested || opts.signal?.aborted || runaway) {
          result = {
            ok: false,
            content: declared
              ? "Not executed: the turn was already concluded."
              : pauseRequested
                ? "Not executed: the caller requested a pause at this phase boundary."
                : opts.signal?.aborted
                  ? "Not executed: cancelled by signal."
                  : "Not executed: repeated identical calls reached the loop limit.",
          };
        } else if (invalid || !tool) {
          result = {
            ok: false,
            content:
              invalid ??
              `unknown tool "${call.name}" — available: ${[...available.keys()].join(", ")}`,
          };
        } else {
          try {
            result = await tool.run(input, {
              sandbox: opts.sandbox,
              testCommand: task.testCommand,
            });
          } catch (err) {
            result = {
              ok: false,
              content: `error: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          if (call.name === "finish" && tool === finishTool && result.ok) {
            const meta = result.meta ?? {};
            const ok = meta.success !== false;
            const disposition =
              meta.disposition === "watch" || meta.disposition === "blocked"
                ? meta.disposition
                : meta.watch
                  ? "watch"
                  : ok
                    ? "done"
                    : "blocked";
            declared = {
              ok,
              summary: String(meta.summary ?? ""),
              disposition,
              watch: meta.watch as Record<string, unknown> | undefined,
              resumeAt:
                typeof meta.resumeAt === "string" ? meta.resumeAt : undefined,
            };
          }
        }
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
      }
      await persist();
      if (opts.signal?.aborted)
        return conclude("cancelled", {
          ok: false,
          error: "cancelled by signal",
        });
      if (declared)
        return conclude("finished", { ...declared, completion: "declared" });
      if (pauseRequested)
        return conclude("paused", {
          ok: false,
          summary: `Paused at the ${phase} phase by caller policy.`,
        });
      if (runaway) {
        const error =
          "Repeated identical tool calls reached the loop limit; execution stopped.";
        emit({ type: "guardrail", kind: "loop_detected", detail: error });
        return conclude("stalled", { ok: false, error });
      }
    }
  } catch (err) {
    if (opts.signal?.aborted)
      return conclude("cancelled", { ok: false, error: "cancelled by signal" });
    const error = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message: error });
    return conclude("error", { ok: false, error });
  }
}
