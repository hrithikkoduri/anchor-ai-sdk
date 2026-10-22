/**
 * The default agent runtime: model → authorized tools → observations → model.
 * A normal final response ends the turn. It is not a test certificate, a task
 * completion claim, or permission to publish. Phases are agent-controlled
 * descriptions of the approach, not a second gated execution engine.
 */
import type { LLMMessage } from "../llm/types.js";
import type { ToolResult } from "../tools/types.js";
import { createFinishTool } from "../tools/finish.js";
import { toolVerb } from "../tools/activity.js";
import {
  BudgetTracker,
  DEFAULT_BUDGET_LIMITS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "./budgets.js";
import {
  DEFAULT_TRUNCATED_REPLY_CHARS,
  DEFAULT_MAX_ASSISTANT_CHARS,
  elideReply,
  spillReply,
} from "./elision.js";
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
import {
  renderInboxTask,
  type InboxMessage,
  type RunSummary,
} from "./inbox.js";
import { defineTool, type Tool } from "../tools/types.js";
import { gitSnapshot } from "./snapshot.js";
import { TraceFanout } from "../trace/sink.js";
import {
  budgetWarning,
  revivalBlock,
  warnPercent as revivalWarnPercent,
} from "./revival.js";
import { phaseDisciplineBlock } from "./phase-discipline.js";
import { resolveTurnIntent } from "./intent.js";
import {
  addRequirement,
  compileLedger,
  ledgerGate,
  linkEvidence,
  recordEvidence,
  renderLedger,
  setRequirementStatus,
  verifyAlignment,
  type VerifierConfig,
} from "../ledger/index.js";
import { chatAgent } from "../agents/chat/index.js";
import { codingAgent } from "../agents/coding/index.js";
import type { EventSink, RevivalRequest } from "./events.js";
import {
  dispatchToolCalls,
  type OperationRuntime,
} from "./dispatch.js";
import {
  mintOperationId,
  reconcilePendingOperations,
  settleFromResult,
  type PendingOperation,
  type ReconcileOutcome,
} from "./operations.js";
import {
  RepeatTracker,
  cappedReplyNudge,
  createCourseCorrect,
  emptyTurnNudge,
  proseCheckpoint as proseCheckpointMessage,
  repeatedCallNudge,
  silentNudge,
  verboseNudge,
  visibleOutputTokens,
} from "./guardrails.js";
import type {
  RunTask,
  EngineOptions,
  AgentResult,
  BackgroundJob,
  FinishReason,
} from "./types.js";
import {
  pollBackgroundJobs,
  renderBackgroundResult,
  renderLostJob,
  waitForBackgroundJobs,
  type FinishedJob,
  type LostJob,
} from "./background.js";

export type {
  RunTask,
  EngineOptions,
  AgentResult,
  FinishReason,
  GuardrailConfig,
} from "./types.js";

/**
 * What a chained call carries from one run into the next. Absent for a
 * standalone run, which is why every field is optional and every default
 * reproduces today's behavior exactly.
 */
interface ChainRun {
  /** Seeded with the chain's spend so budgets bind across runs, not per run. */
  budget?: BudgetTracker;
  /** Steps already taken earlier in the chain, for the step ceiling. */
  stepsBefore?: number;
  /** Jobs still running when the previous run ended. */
  jobs?: BackgroundJob[];
  /** The batch this run was started with, surfaced as one event. */
  delivered?: InboxMessage[];
  /** Pending interjection ids, sampled at each turn boundary. */
  interrupt?: () => Promise<boolean>;
  /** Is any inbox work pending? Lets a finishing run carry its jobs forward. */
  hasPending?: () => Promise<boolean>;
}

async function runOne(
  task: RunTask,
  opts: EngineOptions,
  chain: ChainRun = {},
): Promise<AgentResult> {
  const strategy = opts.strategy ?? opts.agent?.strategy;
  if (!strategy)
    throw new Error(
      "runAgent needs an agent or a strategy — pass opts.agent (chatAgent, codingAgent, …) or opts.strategy",
    );
  // ---- Run lifecycle ------------------------------------------------------
  // The engine owns the run loop end to end: one merged abort signal (the
  // caller's signal OR a polled cancel any process can set), one heartbeat
  // beating for as long as the run lives, and one TraceFanout assigning the
  // single sequence number and redacting once before every sink. `onEvent`
  // still receives raw events for live consumers.
  const controller = new AbortController();
  const signal = controller.signal;
  const abortFromCaller = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const fanout = opts.traceSinks?.length
    ? new TraceFanout(opts.traceSinks)
    : null;
  let stopped = false;
  /** Idempotent: stop the timers, unlink the caller's signal, flush sinks. */
  const stopLifecycle = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    opts.signal?.removeEventListener("abort", abortFromCaller);
    if (fanout) await fanout.flush();
  };
  const emit: EventSink = (event) => {
    fanout?.record(event);
    try {
      opts.onEvent?.(event);
    } catch {
      // A subscriber must never kill the run — same rule as sinks.
    }
  };
  const tools = opts.tools ?? opts.agent?.tools ?? [];
  const available = new Map(tools.map((tool) => [tool.definition.name, tool]));
  /** The context every tool gets — including the host's background policy. */
  const toolContext = {
    sandbox: opts.sandbox,
    ...(opts.backgroundAfterSecs !== undefined
      ? { backgroundAfterSecs: opts.backgroundAfterSecs }
      : {}),
    ...(signal ? { signal } : {}),
  };
  /** Surface a detached command to the consumer that owns delivery. */
  const emitBackground = (
    name: string,
    callId: string | undefined,
    result: ToolResult,
  ) => {
    const meta = result.meta;
    const job =
      meta && typeof meta.background === "object" && meta.background !== null
        ? (meta.background as { jobId?: unknown })
        : undefined;
    if (!job || typeof job.jobId !== "string") return;
    emit({
      type: "background_started",
      jobId: job.jobId,
      tool: name,
      ...(callId ? { callId } : {}),
      ...(meta && typeof meta.command === "string"
        ? { command: meta.command }
        : {}),
      ...(meta && typeof meta.timeoutSecs === "number"
        ? { timeoutSecs: meta.timeoutSecs }
        : {}),
    });
  };
  // Terminal intrinsic — with the consumer's handoff shape when configured
  // (EngineOptions.handoff). Never required to stop.
  let completionGate:
    | ((summary: string, success: boolean) => Promise<{ ok: boolean; content: string }>)
    | undefined;
  let verified = false;
  let finishGateAttempts = 0;
  const finish = createFinishTool({
    ...(opts.handoff ? { handoff: opts.handoff } : {}),
    validate: async (input) =>
      completionGate
        ? completionGate(input.summary, input.success)
        : { ok: true },
  });
  if (opts.intrinsics?.finish !== false) available.set("finish", finish);
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

  const budget = chain.budget ?? new BudgetTracker(opts.budgets);

  // ---- Task verification ------------------------------------------------
  const verifierOn = opts.verifier !== undefined && opts.verifier !== false;
  const verifierConfig: VerifierConfig =
    verifierOn && typeof opts.verifier === "object" ? opts.verifier : {};
  const verifierLlm = verifierConfig.llm ?? opts.llm;
  const verifierGates = new Set(
    verifierConfig.gates ?? ["phase", "finish"],
  );
  const maxVerifierCalls = verifierConfig.maxCallsPerTask ?? 6;
  let verifierCalls = 0;
  let ledger = opts.ledger ?? (verifierOn ? prior?.ledger : undefined);
  if (verifierOn && !ledger) {
    const compiled = await compileLedger({
      llm: verifierLlm,
      taskId: opts.thread?.id ?? `task-${Date.now()}`,
      task: task.task,
      phases: strategy.phases,
      reasoningEffort: "low",
    });
    ledger = compiled.ledger;
    if (compiled.usage) budget.record(compiled.usage);
  }
  const recentEvidence = (): string => {
    if (!ledger) return "(none)";
    return Object.values(ledger.evidence)
      .slice(-6)
      .map(
        (item) =>
          `${item.id} ${item.tool}${item.summary ? `: ${item.summary}` : ""}${item.ok ? "" : " (failed)"}`,
      )
      .join("\n");
  };
  const callVerifier = async (
    phaseGoal: { id: string; goal: string; guidance?: string },
  ) => {
    if (!verifierOn || !ledger || verifierCalls >= maxVerifierCalls) {
      return { allow: true } as const;
    }
    verifierCalls += 1;
    try {
      const { verdict, usage } = await verifyAlignment({
        llm: verifierLlm,
        task: task.task,
        phase: phaseGoal,
        ledger,
        recentEvidence: recentEvidence(),
        reasoningEffort: "low",
      });
      if (usage) budget.record(usage);
      return verdict;
    } catch (error) {
      emit({
        type: "advisory",
        kind: "verifier_failed",
        detail:
          error instanceof Error ? error.message : String(error),
      });
      return {
        allow: verifierConfig.onError !== "block",
        aligned: false,
        justified: true,
        reason: "verifier unavailable",
        requiredAction: "none" as const,
        confidence: 0,
      };
    }
  };
  if (verifierOn && ledger) {
    completionGate = async (summaryText) => {
      const structural = ledgerGate(ledger!, {
        allowWaived: verifierConfig.allowWaived,
      });
      if (!structural.allow) {
        return {
          ok: false,
          content: [
            "Verification gate: required work is not complete.",
            `open: ${structural.open.join(", ") || "none"}`,
            `missingEvidence: ${structural.missingEvidence.join(", ") || "none"}`,
            `failures: ${structural.failures.join(" | ") || "none"}`,
            "Attach evidence to each requirement with update_ledger, resolve failures, and try again.",
          ].join("\n"),
        };
      }
      if (!verifierGates.has("finish")) {
        verified = true;
        return { ok: true, content: "" };
      }
      const verdict = await callVerifier({
        id: "finish",
        goal: "Deliver the task outcome with evidence.",
      });
      if (verdict.allow) {
        verified = true;
        return { ok: true, content: "" };
      }
      return {
        ok: false,
        content:
          `Verification gate rejected completion: ${verdict.reason ?? "unsupported claim"}. ` +
          `Required action: ${verdict.requiredAction ?? "gather_evidence"}. ` +
          `Claim: ${summaryText.slice(0, 400)}`,
      };
    };
  }
  const currentRequest = userMessage(task.task);
  const revivalOn = !!opts.revival;
  const revivalWarnAt = revivalWarnPercent(
    opts.revival ? opts.revival.warnAtPercent : undefined,
  );
  let revivalWarned = false;
  let revivalRequest: RevivalRequest | undefined;
  const phaseOn =
    strategy.phases.length > 1 && opts.intrinsics?.phase !== false;
  const system = () => ({
    role: "system" as const,
    content:
      strategy.systemPrompt({ task: task.task, context, summary }) +
      (phaseOn ? `\n\n${phaseDisciplineBlock(strategy.phases)}` : "") +
      (revivalOn ? `\n\n${revivalBlock(revivalWarnAt)}` : "") +
      (ledger
        ? `\n\nPROGRESS LEDGER (authoritative task state):\n${renderLedger(ledger)}\n\nUse update_ledger to link evidence to each requirement and mark it verified. Do not claim completion while a required item is open or lacks evidence.`
        : ""),
  });
  if (ledger) {
    const updateLedger = defineTool(
      {
        name: "update_ledger",
        description:
          "Update the task contract. Use it after gathering evidence: link a tool result to a requirement, mark it verified, record an open failure, or set the next step. Never invent evidence ids.",
        parameters: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: [
                "add_requirement",
                "link_evidence",
                "set_status",
                "set_next_step",
                "add_failure",
                "clear_failure",
              ],
            },
            text: { type: "string" },
            required: { type: "boolean" },
            requirementId: { type: "string" },
            evidenceId: { type: "string" },
            status: {
              type: "string",
              enum: ["open", "in_progress", "verified", "blocked", "waived"],
            },
            failure: { type: "string" },
          },
          required: ["op"],
          additionalProperties: false,
        },
      },
      async (input) => {
        const op = String(input.op ?? "");
        if (op === "add_requirement") {
          const text = String(input.text ?? "").trim();
          if (!text) return { ok: false, content: "text is required" };
          const requirement = addRequirement(
            ledger!,
            { text, required: input.required !== false },
            "agent",
          );
          return {
            ok: true,
            content: `added ${requirement.id}: ${requirement.text}`,
          };
        }
        if (op === "link_evidence") {
          linkEvidence(
            ledger!,
            String(input.requirementId ?? ""),
            String(input.evidenceId ?? ""),
          );
          return { ok: true, content: "evidence linked" };
        }
        if (op === "set_status") {
          const status = String(input.status ?? "");
          if (status === "superseded") {
            return { ok: false, content: "use a user revision to supersede" };
          }
          const requirementId = String(input.requirementId ?? "");
          if (status === "verified") {
            const requirement = ledger!.requirements.find(
              (item) => item.id === requirementId,
            );
            if (!requirement || requirement.evidenceIds.length === 0) {
              return {
                ok: false,
                content:
                  "link evidence to this requirement before marking it verified",
              };
            }
          }
          setRequirementStatus(
            ledger!,
            requirementId,
            status as "open" | "in_progress" | "verified" | "blocked" | "waived",
          );
          return { ok: true, content: `status set to ${status}` };
        }
        if (op === "set_next_step") {
          ledger!.nextStep = String(input.text ?? "");
          return { ok: true, content: "next step recorded" };
        }
        if (op === "add_failure") {
          const failure = String(input.failure ?? "").trim();
          if (!failure) return { ok: false, content: "failure is required" };
          ledger!.openFailures.push(failure);
          return { ok: true, content: "failure recorded" };
        }
        if (op === "clear_failure") {
          const failure = String(input.failure ?? "");
          ledger!.openFailures = ledger!.openFailures.filter(
            (item) => item !== failure,
          );
          return { ok: true, content: "failure cleared" };
        }
        return { ok: false, content: `unknown ledger op "${op}"` };
      },
      { verb: "Updating the progress ledger" },
    );
    available.set("update_ledger", updateLedger);
  }

  const messages: LLMMessage[] = [
    system(),
    ...conversationHistory(prior?.messages ?? []),
    currentRequest,
  ];
  const compact =
    opts.compaction === false
      ? null
      : { ...DEFAULT_COMPACTION, ...opts.compaction };
  // The model's view of the transcript, bounded by assistant-text elision
  // (#77). `messages` stays whole — this only changes what is SENT.
  const elidedByMessage = new WeakMap<LLMMessage, LLMMessage>();
  const forModel = (): LLMMessage[] =>
    messages.map((m) => elidedByMessage.get(m) ?? m);
  const evidence: ToolResultRecord[] = [];
  // Commands the provider detached. The engine owns their results: it polls at
  // every turn boundary and, before a normal finish, waits for what is left.
  let outstanding: BackgroundJob[] = [
    ...(opts.resumeJobs ?? []),
    ...(chain.jobs ?? []),
  ];
  /**
   * External operations recovery could not resolve. When non-empty, the run
   * never reaches a model call: replaying an ambiguous write is worse than
   * stopping. Reported as `reason: "recovery_required"`.
   */
  const unresolvedOperations: PendingOperation[] = [];
  // Thresholds that double as switches (`number | false`) must be positive
  // when numeric. 0 is not "off" — `false` is — and left alone it would mean
  // "immediately" for the nudges while meaning "uncapped" for the caps.
  const positiveNumber = (name: string, value: number): number => {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(
        `anchor: ${name} must be a positive number or false (got ${value})`,
      );
    return value;
  };
  const threshold = (name: string, value: number | false): number | false =>
    value === false ? false : positiveNumber(name, value);
  const repeatLimit = threshold(
    "guardrails.repeatedToolCallLimit",
    opts.guardrails?.repeatedToolCallLimit ?? 3,
  );
  const toolOnlyNudge = threshold(
    "guardrails.toolOnlyNudgeLimit",
    opts.guardrails?.toolOnlyNudgeLimit ?? 8,
  );
  const verboseTurnLimit = threshold(
    "guardrails.verboseTurnLimit",
    opts.guardrails?.verboseTurnLimit ?? 8_000,
  );
  const repeat = new RepeatTracker(repeatLimit);
  let verboseNudged = false;
  // Per-call output cap. The agent bundle may suggest one; an explicit engine
  // option wins, exactly like `strategy` and `tools` resolution.
  const outputTokenCap =
    opts.maxOutputTokens ?? opts.agent?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxOutputTokens =
    outputTokenCap === false
      ? undefined
      : positiveNumber("maxOutputTokens", outputTokenCap);
  // Explicit option wins over the bundle's suggestion, like maxOutputTokens.
  const reasoningEffort =
    opts.reasoningEffort ?? opts.agent?.reasoningEffort;
  const maxAssistantChars = threshold(
    "maxAssistantChars",
    opts.maxAssistantChars ?? DEFAULT_MAX_ASSISTANT_CHARS,
  );
  const truncatedReplyChars = threshold(
    "truncatedReplyChars",
    opts.truncatedReplyChars ?? DEFAULT_TRUNCATED_REPLY_CHARS,
  );
  let silentToolTurns = 0;
  let steps = 0;
  const stepsBefore = chain.stepsBefore ?? 0;
  // Recovery for tools that declare an external effect. Scope defaults to the
  // thread; a store without either is a wiring bug, not a silent no-op.
  const operations = opts.operations;
  const operationScope = operations
    ? (operations.scope ?? opts.thread?.id)
    : undefined;
  if (operations && operationScope === undefined)
    throw new Error(
      "anchor: operations.scope is required when the run has no thread id",
    );
  const operationCalls = new Map<string, { name: string; callId?: string }>();
  const missingJournal = new Set<string>();
  const onMissingJournal = (tool: Tool): void => {
    const name = tool.definition.name;
    if (missingJournal.has(name)) return;
    missingJournal.add(name);
    emit({
      type: "advisory",
      kind: "effect_without_journal",
      detail:
        `tool "${name}" declares an external effect, but no operations store is configured — ` +
        "a crash between the write and its result can repeat it. Pass EngineOptions.operations.",
    });
  };
  const operationRuntime: OperationRuntime | undefined =
    operations && operationScope !== undefined
      ? (() => {
          const { store } = operations;
          return {
            async begin(call, input, tool) {
              const keyed = tool.effect?.key?.(input);
              const operationId =
                keyed !== undefined && keyed.trim() !== ""
                  ? keyed
                  : mintOperationId();
              const started = await store.begin({
                operationId,
                scope: operationScope,
                tool: call.name,
                input,
                status: "intent",
                startedAt: Date.now(),
              });
              operationCalls.set(operationId, {
                name: call.name,
                ...(call.id ? { callId: call.id } : {}),
              });
              return { operationId, started };
            },
            async acknowledge(operationId, ack) {
              try {
                await store.acknowledge(operationId, ack);
              } catch {
                /* acceptance is a fact even when the journal is unavailable */
              }
              const recordedCall = operationCalls.get(operationId);
              emit({
                type: "tool_ack",
                name: recordedCall?.name ?? "unknown",
                ...(recordedCall?.callId
                  ? { callId: recordedCall.callId }
                  : {}),
                operationId,
                phase,
                step: steps,
                ack,
              });
            },
            async settle(operationId, result) {
              try {
                await store.settle(operationId, settleFromResult(result));
                return true;
              } catch (err) {
                emit({
                  type: "advisory",
                  kind: "operation_settle_failed",
                  detail:
                    `could not record the result of operation ${operationId}: ` +
                    (err instanceof Error ? err.message : String(err)),
                });
                return false;
              }
            },
          };
        })()
      : undefined;
  // #78: the engine asked the model for something visible and the model
  // answered in prose and stopped. That is a checkpoint, not a result. Scoped
  // to nudges on purpose: an ordinary prose ending after tool work is the
  // normal way runs finish, and gating it would cost every run an extra call.
  let pendingProseCheck = false;
  let proseChecked = false;
  // A capped prose turn is incomplete, not an answer. Continue once (#79);
  // a second cap in the same run stalls, so a runaway essay cannot loop.
  let outputCapContinued = false;
  // The first identical-call loop is a course-correction. The second stalls,
  // so a no-op edit cannot burn the token budget.
  let loopNudged = false;
  // An empty turn (no text, no tool call) gets one correction. The flag is
  // how the next empty turn is recognized as "after the advisory."
  let emptyNudged = false;
  const proseCheckpoint = opts.guardrails?.proseCheckpoint ?? true;
  // The shared mechanic lives in guardrails.ts; the policy (when a correction
  // fires, and when it stops) stays here.
  const courseCorrect = createCourseCorrect({
    emit,
    messages,
    persist: async () => {
      await persist();
    },
    markProseCheck: () => {
      pendingProseCheck = true;
    },
  });
  let checkpointRef: string | undefined;
  let pauseRequested = false;
  if (phaseOn) {
    available.set(
      "set_phase",
      defineTool(
        {
          name: "set_phase",
          description:
            "Record the phase of work you are in — it keeps you focused and the thread's timeline honest. Update it when the kind of work changes; pick the phase that fits, and you may skip or revisit one.",
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
              content: `Unknown phase. Available: ${strategy.phases.map((item) => item.id).join(", ")}.`,
            };
          const previous = phase;
          if (
            verifierOn &&
            ledger &&
            verifierGates.has("phase") &&
            target.id !== previous
          ) {
            const verdict = await callVerifier(target);
            if (!verdict.allow) {
              emit({
                type: "guardrail",
                kind: "transition_rejected",
                detail: `${previous} -> ${target.id}: ${verdict.reason}`,
              });
              return {
                ok: false,
                content: [
                  `Phase transition rejected: ${verdict.reason}`,
                  `Required action: ${verdict.requiredAction}`,
                  "Gather the missing evidence or update the ledger, then transition again.",
                ].join("\n"),
              };
            }
          }
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

  if (revivalOn) {
    available.set(
      "request_revival",
      defineTool(
        {
          name: "request_revival",
          description:
            "State what work remains and your estimate of the next run's needs when you cannot finish before the budget runs out. The consumer may fund a fresh run from it. Include your own buffer; an under-estimate fails, an inflated one is not trusted. This records a handoff; it does not end the run.",
          parameters: {
            type: "object",
            properties: {
              remaining: {
                type: "string",
                description: "What work remains, briefly and concretely.",
              },
              estimatedSteps: {
                type: "number",
                description: "Turns the next run likely needs to finish.",
              },
              estimatedTokens: {
                type: "number",
                description: "Total tokens the next run likely needs.",
              },
            },
            required: ["remaining"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const remaining =
            typeof input.remaining === "string" ? input.remaining.trim() : "";
          if (!remaining)
            return {
              ok: false,
              content: "Say what work remains before requesting a revival.",
            };
          const positive = (value: unknown) =>
            typeof value === "number" && Number.isFinite(value) && value > 0
              ? Math.ceil(value)
              : undefined;
          const estimatedSteps = positive(input.estimatedSteps);
          const estimatedTokens = positive(input.estimatedTokens);
          revivalRequest = {
            remaining,
            ...(estimatedSteps !== undefined ? { estimatedSteps } : {}),
            ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
          };
          emit({ type: "revival_requested", request: revivalRequest });
          return {
            ok: true,
            content:
              "Handoff recorded. If the budget runs out, the next run starts from it; changed work is checkpointed at the boundary.",
          };
        },
        { verb: "Requesting budget for the remaining work" },
      ),
    );
  }

  /**
   * Settle operations only AFTER the conversation that contains their results
   * is durable. The opposite order opens the window this whole layer exists to
   * close: a settled journal entry with no result in the thread, which the next
   * run would have to replay. A failed save leaves them pending instead.
   */
  const pendingSettlements: Array<{
    operationId: string;
    result: ToolResult;
  }> = [];
  const settleRecorded = async (persisted: boolean): Promise<void> => {
    if (!operationRuntime || !persisted) return;
    while (pendingSettlements.length > 0) {
      const settled = pendingSettlements.shift()!;
      await operationRuntime.settle(settled.operationId, settled.result);
    }
  };
  const persist = async (
    done = false,
    resumePhase?: string,
  ): Promise<boolean> => {
    try {
      await opts.thread?.store.save(opts.thread.id, {
        summary,
        messages: conversationHistory(messages),
        phase: done ? resumePhase : phase,
        ...(ledger ?? prior?.ledger
          ? { ledger: ledger ?? prior?.ledger }
          : {}),
      });
      return true;
    } catch {
      /* a storage outage must not corrupt the model/tool protocol */
      return false;
    }
  };
  const conclude = async (
    reason: FinishReason,
    extra: {
      ok: boolean;
      summary?: string;
      error?: string;
      handoff?: Record<string, unknown>;
      completion?: "response" | "declared";
    },
  ): Promise<AgentResult> => {
    // Snapshots are a persistence concern, not a phase the model must enter.
    // Avoid empty commits, especially for reviews and simple conversation.
    if (opts.sandbox && opts.snapshot !== false) {
      try {
        const snapshot = await (opts.snapshot ?? gitSnapshot())({
          reason: reason === "paused" ? "pause" : "finish",
          label: "turn boundary",
          sandbox: opts.sandbox,
        });
        if (snapshot) {
          checkpointRef = snapshot.ref;
          emit({
            type: "checkpoint",
            ref: snapshot.ref,
            label: "turn boundary",
            ...(snapshot.pushedTo ? { pushedTo: snapshot.pushedTo } : {}),
            ...(snapshot.pushError ? { pushError: snapshot.pushError } : {}),
          });
        }
      } catch (err) {
        // Best-effort — never a reason to keep reasoning, but never silent
        // either: a non-git sandbox reads as all-new and the default git
        // snapshot will fail here on every run. Traces must show it.
        emit({
          type: "advisory",
          kind: "snapshot_failed",
          detail:
            "snapshot failed and was skipped: " +
            (err instanceof Error ? err.message : String(err)),
        });
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
      ...(budget.cachedTokens > 0
        ? { cachedTokens: budget.cachedTokens }
        : {}),
    };
    emit({
      type: "run_finished",
      ok: extra.ok,
      summary: extra.summary,
      steps,
      usage,
      reason,
      ...(extra.handoff !== undefined ? { handoff: extra.handoff } : {}),
    });
    const persisted = await persist(
      reason !== "paused",
      extra.handoff !== undefined
        ? opts.handoff?.threadPhase?.(extra.handoff)
        : undefined,
    );
    await settleRecorded(persisted);
    // Every exit passes through here: stop beating, unlink the caller's
    // signal, and make sure the sinks hold the complete journal — including
    // this run_finished — before the caller sees the result.
    await stopLifecycle();
    return {
      ...extra,
      reason,
      steps,
      usage,
      messages,
      checkpointRef,
      phase,
      evidence,
      ...(ledger ? { ledger } : {}),
      ...(verifierOn ? { verified } : {}),
      ...(revivalRequest &&
      (reason === "budget_exceeded" || reason === "max_steps")
        ? { revival: revivalRequest }
        : {}),
      ...(outstanding.length > 0 ? { pendingJobs: [...outstanding] } : {}),
      ...(unresolvedOperations.length > 0
        ? { pendingOperations: [...unresolvedOperations] }
        : {}),
    };
  };

  /**
   * Inject what the poll returned. Runtime-only (`origin: "engine"`): the
   * model sees it, the thread never stores it, the user never reads it.
   */
  const absorbJobs = async (
    finished: FinishedJob[],
    lost: LostJob[],
  ): Promise<number> => {
    for (const job of finished) {
      messages.push({
        role: "user",
        // `runtime`, not `engine`: a job result is a fact, so it survives in
        // the thread for a resumed run. Consumers may hide it in the UI.
        origin: "runtime",
        content: await renderBackgroundResult(job, opts.sandbox),
      });
      emit({
        type: "background_completed",
        jobId: job.job.jobId,
        tool: job.job.tool,
        exitCode: job.result.exitCode,
        timedOut: job.result.timedOut,
      });
    }
    for (const job of lost) {
      messages.push({
        role: "user",
        origin: "runtime",
        content: renderLostJob(job),
      });
    }
    return finished.length + lost.length;
  };

  /** One non-blocking round, at the turn boundary. */
  const pollJobs = async (): Promise<void> => {
    if (outstanding.length === 0) return;
    const outcome = await pollBackgroundJobs(opts.sandbox, outstanding);
    outstanding = outcome.running;
    await absorbJobs(outcome.finished, outcome.lost);
  };

  /**
   * Before finishing, wait for what is left — ending would lose it. Unless the
   * inbox already guarantees another run: then the job is carried forward and
   * the interjection is not held hostage by a long command.
   */
  const settleBeforeFinish = async (): Promise<boolean> => {
    if (outstanding.length === 0) return false;
    if (
      chain.hasPending &&
      (await chain.hasPending().catch(() => false))
    )
      return false;
    const outcome = await waitForBackgroundJobs(opts.sandbox, outstanding, {
      ...(signal ? { signal } : {}),
    });
    outstanding = outcome.running;
    return (await absorbJobs(outcome.finished, outcome.lost)) > 0;
  };

  if (opts.cancel) {
    const everyMs = opts.cancel.everyMs ?? 2_000;
    const timer = setInterval(() => {
      void Promise.resolve()
        .then(() => opts.cancel!.isCancelled())
        .then((cancelled) => {
          if (cancelled) controller.abort();
        })
        .catch(() => undefined);
    }, everyMs);
    timer.unref?.();
    timers.push(timer);
  }
  if (opts.heartbeat) {
    const everyMs = opts.heartbeat.everyMs ?? 30_000;
    const beat = () =>
      void Promise.resolve()
        .then(() => opts.heartbeat!.beat())
        .catch(() => undefined);
    beat();
    const timer = setInterval(beat, everyMs);
    timer.unref?.();
    timers.push(timer);
  }
  emit({
    type: "run_started",
    task: task.task,
    phases: strategy.phases.map((item) => item.id),
  });
  if (chain.delivered?.length)
    emit({
      type: "inbox_delivered",
      messages: chain.delivered.map((message) => ({
        id: message.id,
        delivery: message.delivery,
      })),
    });
  emit({ type: "phase_started", phase });
  // Resume recovery runs BEFORE the first model call: an effect that may have
  // landed must never be replayed, and one that did land must be visible to the
  // model. An unknowable outcome stops the run instead of guessing.
  if (operations && operationScope !== undefined) {
    let outcomes: ReconcileOutcome[];
    try {
      outcomes = await reconcilePendingOperations({
        store: operations.store,
        scope: operationScope,
        tools: [...available.values()],
        context: toolContext,
      });
    } catch (err) {
      return conclude("error", {
        ok: false,
        error:
          "anchor: could not read pending operations — refusing to start " +
          `(${err instanceof Error ? err.message : String(err)})`,
      });
    }
    for (const outcome of outcomes) {
      emit({
        type: "reconciled",
        operationId: outcome.operation.operationId,
        tool: outcome.operation.tool,
        status: outcome.status,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      });
      if (outcome.status === "applied") {
        messages.push({
          role: "user",
          origin: "runtime",
          content:
            `[runtime] Operation ${outcome.operation.operationId} ` +
            `(${outcome.operation.tool}) was already applied before this run resumed.` +
            (outcome.result?.content ? `\n${outcome.result.content}` : ""),
        });
      } else if (outcome.status === "not_applied") {
        messages.push({
          role: "user",
          origin: "runtime",
          content:
            `[runtime] Operation ${outcome.operation.operationId} ` +
            `(${outcome.operation.tool}) was NOT applied. It is safe to perform ` +
            "the action again if it is still needed.",
        });
      } else {
        unresolvedOperations.push(outcome.operation);
      }
    }
    if (unresolvedOperations.length > 0) {
      return conclude("recovery_required", {
        ok: false,
        error:
          `anchor: ${unresolvedOperations.length} external operation(s) have an unknown outcome ` +
          `(${unresolvedOperations.map((operation) => operation.operationId).join(", ")}). ` +
          "They were not replayed. Reconcile them, then run again.",
      });
    }
  }
  try {
    for (;;) {
      if (signal.aborted)
        return conclude("cancelled", {
          ok: false,
          error: "cancelled by signal",
        });
      // A pending interjection outranks the next model call. Sampled at the
      // boundary — never mid-turn, where the transcript would be invalid — so
      // the run stops with the turn it already completed intact.
      if (chain.interrupt) {
        const pending = await chain.interrupt().catch(() => false);
        if (pending) {
          emit({ type: "inbox_interject" });
          return conclude("interrupted", {
            ok: false,
            error: "interrupted by a pending message",
          });
        }
      }
      const over = budget.exceeded(stepsBefore + steps);
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
      if (revivalOn && !revivalWarned) {
        // One warning, before the wall: the model can either spend what is
        // left well or leave a funded handoff for the next run. Tokens,
        // steps, AND dollars each bind — a pricier model hits the dollar cap
        // long before the token cap, and dying without a warning means no
        // chance to leave a handoff.
        const tokensUsed = budget.totalTokens();
        const tokensHit =
          budget.limits.maxTokens > 0 &&
          tokensUsed >= budget.limits.maxTokens * (revivalWarnAt / 100);
        const stepsHit =
          budget.limits.maxSteps > 0 &&
          stepsBefore + steps >=
            budget.limits.maxSteps * (revivalWarnAt / 100);
        const usdHit =
          budget.costsKnown &&
          budget.limits.maxUsd > 0 &&
          budget.costUsd >= budget.limits.maxUsd * (revivalWarnAt / 100);
        if (tokensHit || stepsHit || usdHit) {
          revivalWarned = true;
          emit({
            type: "advisory",
            kind: "budget_warning",
            detail:
              `budget nearing its limit (${tokensUsed}/${budget.limits.maxTokens} tokens, ` +
              `${steps}/${budget.limits.maxSteps} steps` +
              (budget.costsKnown
                ? `, $${budget.costUsd.toFixed(2)}/$${budget.limits.maxUsd}`
                : "") +
              ")",
          });
          messages.push({
            role: "user",
            origin: "engine",
            content: budgetWarning({
              tokensUsed,
              tokenLimit: budget.limits.maxTokens,
              stepsUsed: steps,
              stepLimit: budget.limits.maxSteps,
              ...(budget.costsKnown
                ? { usdUsed: budget.costUsd, usdLimit: budget.limits.maxUsd }
                : {}),
            }),
          });
        }
      }
      if (compact && estimateTokens(messages) > compact.maxEstimatedTokens) {
        const folded = await compactConversation({
          llm: opts.llm,
          messages: forModel(),
          runningSummary: summary,
          keepRecentTokens: compact.keepRecentTokens,
          signal,
        });
        if (folded) {
          budget.record(folded.usage);
          summary = folded.summary;
          const tail = folded.keptMessages;
          // After a fold the model's earlier detail is gone from context;
          // point it at the durable record (see the Working notes section).
          const foldNote = {
            role: "user" as const,
            content:
              "[runtime] Context was folded to stay within the window. Your working notes " +
              "file (.anchor/notes.md, git-excluded) is the durable record of findings and " +
              "next steps — re-read it when you need detail from before the fold.",
          };
          // Preserve the actual current request even if its earlier position
          // was folded. Do not replace it with a generic "Begin" instruction.
          messages.splice(
            0,
            messages.length,
            system(),
            ...(tail.includes(currentRequest) ? [] : [currentRequest]),
            foldNote,
            ...tail,
          );
          emit({
            type: "compacted",
            removedMessages: folded.removedCount,
            keptMessages: tail.length,
            summaryChars: summary.length,
            summary,
            folding: folded.foldingPreview,
            usage: folded.usage,
          });
          // Compaction itself consumes budget; check again before inference.
          const after = budget.exceeded(stepsBefore + steps);
          if (after)
            return conclude("budget_exceeded", {
              ok: false,
              error: after.detail,
            });
        }
      }
      // The turn boundary the model actually sees: before this call, after any
      // fold. A job that finished since the previous turn (including one
      // carried in from a previous run) rides this call, not the one after.
      await pollJobs();
      // Refresh the authoritative contract every turn so evidence ids and
      // status changes are visible after each tool result.
      if (ledger) messages[0] = system();
      steps++;
      emit({ type: "llm_call_started", phase, step: steps });
      const response = await opts.llm.stream(
        {
          messages: forModel(),
          tools: [...available.values()].map((tool) => ({
            type: "function",
            function: tool.definition,
          })),
          ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
          ...(opts.sampling?.temperature !== undefined
            ? { temperature: opts.sampling.temperature }
            : {}),
          ...(opts.sampling?.seed !== undefined
            ? { seed: opts.sampling.seed }
            : {}),
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        },
        (text) => emit({ type: "llm_text_delta", text }),
        {
          signal,
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
        model: response.model,
        ...(response.provider ? { provider: response.provider } : {}),
      });
      // A capped response is a real event, not a curiosity: the model may have
      // been mid-thought, or about to emit the tool call it never reached.
      const outputCapped =
        maxOutputTokens !== undefined && response.finishReason === "length";
      if (outputCapped) {
        emit({
          type: "advisory",
          kind: "output_truncated",
          detail:
            `step ${steps} hit the ${maxOutputTokens}-token output cap ` +
            `(finishReason "length") — the reply, including any tool call it ` +
            `was still writing, is incomplete`,
        });
      }
      const assistantTurn = assistantMessage(response);
      messages.push(assistantTurn);
      // The model's own words get a boundary too (#77). A runaway reply is
      // replayed bounded while the transcript and the event stream keep it
      // whole; a capped turn keeps its head only, since its tail is mid-token.
      if (maxAssistantChars !== false) {
        const truncatedRule = outputCapped && truncatedReplyChars !== false;
        const replyBudget = truncatedRule
          ? Math.min(maxAssistantChars, truncatedReplyChars)
          : maxAssistantChars;
        if (response.text.length > replyBudget) {
          const pointer = await spillReply(opts.sandbox, response.text);
          const elided = elideReply(response.text, replyBudget, {
            tail: !truncatedRule,
            ...(pointer
              ? {
                  note: `full reply saved at ${pointer} — read_file it if you need the earlier text`,
                }
              : {}),
          });
          elidedByMessage.set(assistantTurn, {
            ...assistantTurn,
            content: elided.text,
          });
          emit({
            type: "advisory",
            kind: "assistant_text_elided",
            detail:
              `step ${steps}: ${response.text.length} chars of assistant text replayed as ${replyBudget}` +
              `${truncatedRule ? " (truncated turn — head only)" : ""}; ${elided.omittedChars} omitted` +
              `${pointer ? `; full text at ${pointer}` : ""}`,
          });
        }
      }
      if (!response.toolCalls.length) {
        if (!response.text.trim()) {
          // Flag, not a message scan: the advisory is already in the
          // conversation, but the stop decision is this boolean.
          if (!emptyNudged) {
            emptyNudged = true;
            await courseCorrect({
              kind: "empty_turn",
              detail: `step ${steps} returned neither text nor a tool call — asked for a real action`,
              content: emptyTurnNudge(available.has("finish")),
            });
            continue;
          }
          return conclude("stalled", {
            ok: false,
            error: "model returned neither text nor tool calls",
          });
        }
        // An unfinished sentence is not an answer. A reply cut off by the cap
        // must never be accepted as the run's result. It also must not end a
        // run that was still working (#79): same shape as a nudge — inject
        // one runtime message and take the next turn. Once per run; a second
        // capped prose turn stalls, so this cannot loop.
        if (outputCapped) {
          if (!outputCapContinued && proseCheckpoint) {
            outputCapContinued = true;
            await courseCorrect({
              kind: "output_cap_continue",
              detail:
                `step ${steps} hit the ${maxOutputTokens}-token output cap with no tool call — ` +
                `asked to continue instead of ending`,
              content: cappedReplyNudge(maxOutputTokens ?? 0, available.has("finish")),
            });
            continue;
          }
          return conclude("stalled", {
            ok: false,
            error:
              `model output hit the ${maxOutputTokens}-token cap mid-reply ` +
              `and returned no tool call — the reply is incomplete`,
          });
        }
        // The engine just asked for something visible, and the model answered
        // in prose and stopped. That is exactly the shape that cut a run off
        // mid-task (#78). Ask once whether the run is really over; the model
        // decides: call `finish`, take another action, or repeat the reply
        // (which ends the run). One-shot, so this can never become a loop.
        if (
          proseCheckpoint &&
          pendingProseCheck &&
          !proseChecked &&
          available.has("finish")
        ) {
          proseChecked = true;
          await courseCorrect({
            kind: "prose_checkpoint",
            detail:
              `step ${steps} replied with text and no tool call after tool work — ` +
              `asked whether the run is finished or continuing`,
            content: proseCheckpointMessage(),
          });
          continue;
        }
        // A pending background job can still change the answer: wait for it and
        // give the model the result rather than losing it at the exit.
        if (await settleBeforeFinish()) continue;
        if (completionGate) {
          const gate = await completionGate(response.text.trim(), true);
          if (!gate.ok) {
            finishGateAttempts += 1;
            emit({
              type: "guardrail",
              kind: "finish_rejected",
              detail: gate.content.slice(0, 500),
            });
            if (finishGateAttempts >= 3) {
              return conclude("stalled", {
                ok: false,
                error: gate.content,
              });
            }
            messages.push({ role: "user", content: gate.content });
            continue;
          }
        }
        return conclude("finished", {
          ok: true,
          summary: response.text.trim(),
          completion: "response",
        });
      }
      pendingProseCheck = false;

      let declared:
        | {
            ok: boolean;
            summary: string;
            handoff?: Record<string, unknown>;
          }
        | undefined;
      let runaway = false;
      const outcome = await dispatchToolCalls({
        calls: response.toolCalls,
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
        ...(operationRuntime ? { operations: operationRuntime } : {}),
        onMissingJournal,
        signal,
        pauseRequested: () => pauseRequested,
        onToolResult: (call, result) => {
          if (
            !ledger ||
            call.name === "finish" ||
            call.name === "update_ledger"
          ) {
            return;
          }
          recordEvidence(ledger, {
            tool: call.name,
            ref: `call:${call.id}`,
            ok: result.ok,
            summary: result.content.replace(/\s+/g, " ").slice(0, 500),
            ...(result.meta ? { meta: result.meta } : {}),
          });
        },
      });
      runaway = outcome.runaway;
      declared = outcome.declared;
      outstanding.push(...outcome.jobs);
      pendingSettlements.push(...outcome.settlements);
      // Materialization advisory (runtime-only, never persisted): a reasoning
      // model's hidden chain is stateless between calls, so after consecutive
      // turns that only call tools, nothing it understood is visible — and
      // nothing will survive context folding. Ask for a reply or a visible
      // status. Advisory only: it neither blocks actions nor ends the run.
      if (toolOnlyNudge !== false) {
        if (response.text.trim() !== "") silentToolTurns = 0;
        else if (++silentToolTurns >= toolOnlyNudge) {
          silentToolTurns = 0;
          await courseCorrect({
            kind: "materialization_nudge",
            detail: `${toolOnlyNudge} consecutive tool turns with no visible text — advised a reply or a visible status`,
            content: silentNudge(toolOnlyNudge),
          });
        }
      }
      // Verbosity advisory — the mirror of the one above. That one answers a
      // model that only acts; this one answers a model that only writes. One
      // turn past `verboseTurnLimit` VISIBLE tokens means it is deliberating in
      // prose instead of moving, which is where a runaway generation starts.
      // Reasoning is excluded: it is hidden, legitimately long, and nudging it
      // tells a thinking model to stop thinking. Fires at most once per run:
      // after that the output cap is the backstop.
      const reasoningTokens = response.usage.reasoningTokens ?? 0;
      const visibleTokens = visibleOutputTokens(response.usage);
      if (
        verboseTurnLimit !== false &&
        !verboseNudged &&
        visibleTokens > verboseTurnLimit
      ) {
        verboseNudged = true;
        await courseCorrect({
          kind: "verbose_turn",
          detail:
            `step ${steps} produced ${visibleTokens} visible output tokens in one turn ` +
            `(limit ${verboseTurnLimit}${reasoningTokens > 0 ? `, ${reasoningTokens} reasoning excluded` : ""}) — ` +
            `advised a status line and an action`,
          content: verboseNudge(visibleTokens),
        });
      }
      const persisted = await persist();
      await settleRecorded(persisted);
      if (signal.aborted)
        return conclude("cancelled", {
          ok: false,
          error: "cancelled by signal",
        });
      if (declared) {
        // Declaring done while a job still runs is not done. Deliver it and let
        // the model confirm; a second finish with nothing outstanding ends.
        if (await settleBeforeFinish()) continue;
        return conclude("finished", { ...declared, completion: "declared" });
      }
      if (pauseRequested)
        return conclude("paused", {
          ok: false,
          summary: `Paused at the ${phase} phase by caller policy.`,
        });
      if (runaway) {
        if (!loopNudged && repeatLimit !== false) {
          loopNudged = true;
          repeat.reset();
          await courseCorrect({
            kind: "repeated_call",
            detail:
              `step ${steps}: identical tool call repeated ${repeatLimit} times — the repeat was not executed`,
            content: repeatedCallNudge(repeatLimit, available.has("finish")),
          });
          continue;
        }
        const error =
          "Repeated identical tool calls reached the loop limit a second time; execution stopped.";
        emit({ type: "guardrail", kind: "loop_detected", detail: error });
        return conclude("stalled", { ok: false, error });
      }
    }
  } catch (err) {
    if (signal.aborted)
      return conclude("cancelled", { ok: false, error: "cancelled by signal" });
    const error = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message: error });
    return conclude("error", { ok: false, error });
  }
}

/** The chain's spend so far, replayed into each run's tracker. */
interface ChainSpend {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  costsKnown: boolean;
  reasoningTokens?: number;
  cachedTokens?: number;
}

function seededBudget(opts: EngineOptions, spend: ChainSpend): BudgetTracker {
  const budget = new BudgetTracker(opts.budgets);
  budget.promptTokens = spend.promptTokens;
  budget.completionTokens = spend.completionTokens;
  budget.costUsd = spend.costUsd;
  budget.costsKnown = spend.costsKnown;
  if (spend.reasoningTokens !== undefined)
    budget.reasoningTokens = spend.reasoningTokens;
  if (spend.cachedTokens !== undefined)
    budget.cachedTokens = spend.cachedTokens;
  return budget;
}

function summarizeRun(
  result: AgentResult,
  usage: AgentResult["usage"],
): RunSummary {
  return {
    reason: result.reason,
    ok: result.ok,
    steps: result.steps,
    usage,
    ...(result.phase !== undefined ? { phase: result.phase } : {}),
    ...(result.summary !== undefined ? { summary: result.summary } : {}),
  };
}

/**
 * One run's own spend. `AgentResult.usage` is CUMULATIVE (the tracker is
 * seeded with the chain's spend so the ceilings bind across runs), so a
 * summary must subtract what the chain had already spent.
 */
function usageDelta(
  now: AgentResult["usage"],
  before: ChainSpend,
): AgentResult["usage"] {
  const reasoning =
    now.reasoningTokens !== undefined
      ? Math.max(0, now.reasoningTokens - (before.reasoningTokens ?? 0))
      : undefined;
  return {
    promptTokens: Math.max(0, now.promptTokens - before.promptTokens),
    completionTokens: Math.max(0, now.completionTokens - before.completionTokens),
    totalTokens: Math.max(0, now.totalTokens - (before.promptTokens + before.completionTokens)),
    ...(now.costUsd !== undefined ? { costUsd: now.costUsd - before.costUsd } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(now.cachedTokens !== undefined
      ? { cachedTokens: Math.max(0, now.cachedTokens - (before.cachedTokens ?? 0)) }
      : {}),
  };
}

/**
 * A run chain (decision #82): one run at a time, with the consumer's inbox as
 * the source of what comes next. The chain shares one budget and carries
 * outstanding background jobs forward, so an interjection costs neither a
 * fresh allowance nor a lost command result.
 *
 * It stops on anything that is not a normal ending — a stall, an error,
 * cancellation, a caller-requested pause, or an exhausted budget — and returns
 * the last run's result with every run summarized on `.runs`.
 */
async function runChain(
  task: RunTask,
  opts: EngineOptions,
): Promise<AgentResult> {
  const inbox = opts.inbox!;
  const { store, channel } = inbox;
  if (!channel) throw new Error("anchor: inbox.channel is required");
  // A run normally spends at least one step, so the budget bounds the chain.
  // This counter only stops the one shape that spends nothing: an interjection
  // arriving before every single model call. No new public dial.
  const maxZeroProgressRuns = Math.max(
    1,
    opts.budgets?.maxSteps ?? DEFAULT_BUDGET_LIMITS.maxSteps,
  );
  let zeroProgressRuns = 0;
  const runs: RunSummary[] = [];
  let spend: ChainSpend = {
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    costsKnown: true,
  };
  let stepsBefore = 0;
  let jobs: BackgroundJob[] | undefined;
  let current: RunTask = task;
  let delivered: InboxMessage[] | undefined;
  let claimed: string[] = [];
  let result: AgentResult | undefined;

  for (;;) {
    const budget = seededBudget(opts, spend);
    result = await runOne(current, opts, {
      budget,
      stepsBefore,
      jobs,
      delivered,
      interrupt: () => store.hasInterject(channel),
      ...(store.hasPending
        ? { hasPending: () => store.hasPending!(channel) }
        : {}),
    });

    // The batch is settled only after the run that consumed it: a run that
    // died of an error releases it, so a retry can claim it again.
    if (claimed.length > 0) {
      const settle =
        result.reason === "error" || result.reason === "cancelled"
          ? store.release(claimed)
          : store.complete(claimed);
      await settle.catch(() => undefined);
      claimed = [];
    }

    const usage = result.usage; // cumulative for the chain
    runs.push(summarizeRun(result, usageDelta(usage, spend)));
    spend = {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: usage.costUsd ?? spend.costUsd,
      costsKnown: usage.costUsd !== undefined,
      ...(usage.reasoningTokens !== undefined
        ? { reasoningTokens: usage.reasoningTokens }
        : {}),
      ...(usage.cachedTokens !== undefined
        ? { cachedTokens: usage.cachedTokens }
        : {}),
    };
    stepsBefore += result.steps;
    zeroProgressRuns = result.steps === 0 ? zeroProgressRuns + 1 : 0;
    jobs = result.pendingJobs;

    const continues =
      result.reason === "finished" ||
      result.reason === "interrupted" ||
      result.reason === "stalled";
    // A budget ending, a pause, a cancel, and an error are the caller's to
    // interpret: claiming more work would spend money or override a pause.
    if (!continues) return { ...result, runs };
    // The chain may end on `interrupted` with no allowance left. Claiming now
    // would hand a batch to a run that can only fail at its first boundary,
    // and the batch would be completed unused — leave it pending instead.
    if (budget.exceeded(stepsBefore)) return { ...result, runs };
    if (zeroProgressRuns >= maxZeroProgressRuns) return { ...result, runs };

    let batch: InboxMessage[];
    try {
      batch = await store.claimAll(channel);
    } catch {
      return { ...result, runs };
    }
    if (batch.length === 0) return { ...result, runs };

    claimed = batch.map((message) => message.id);
    delivered = batch;
    current = inbox.render ? inbox.render(batch) : renderInboxTask(batch);
  }

  // The zero-progress guard fired. Report the last run as it stands; `.runs`
  // shows how many interruptions it took to get here.
  return { ...result!, runs };
}

export async function runAgent(
  task: RunTask,
  opts: EngineOptions,
): Promise<AgentResult> {
  const verifierOn = opts.verifier !== undefined && opts.verifier !== false;
  const intent = resolveTurnIntent(task.task, opts.intent ?? "auto");

  // Conversation turns never create task state: no ledger, no verifier, no
  // coding phases. A clear task uses the caller's agent, or the coding agent.
  if (verifierOn && intent !== "task") {
    const conversation: EngineOptions = {
      ...opts,
      agent: chatAgent,
      verifier: false,
      intent: "chat",
      ledger: undefined,
    };
    return opts.inbox
      ? runChain(task, conversation)
      : runOne(task, conversation);
  }

  const effective: EngineOptions = {
    ...opts,
    agent: opts.agent ?? (verifierOn ? codingAgent : chatAgent),
  };
  return opts.inbox ? runChain(task, effective) : runOne(task, effective);
}
