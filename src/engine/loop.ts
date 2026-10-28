/**
 * The default agent runtime: model → authorized tools → observations → model.
 * A normal final response ends the turn. It is not a test certificate, a task
 * completion claim, or permission to publish. Phases are agent-controlled
 * descriptions of the approach, not a second gated execution engine.
 */
import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import type { ToolResult } from "../tools/types.js";
import { createFinishTool } from "../tools/finish.js";
import { toolVerb } from "../tools/activity.js";
import { validateRepos } from "../repo.js";
import {
  BudgetTracker,
  DEFAULT_BUDGET_LIMITS,
  DEFAULT_CHILD_SOFT_CAP,
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
  compactConversationStructured,
  DEFAULT_COMPACTION,
  estimateTokens,
  renderCompactionHandoff,
} from "./compaction.js";
import {
  assistantMessage,
  conversationHistory,
  toolResultMessage,
} from "./context.js";
import type { ToolResultRecord } from "./strategy.js";
import {
  renderInboxTurn,
  type InboxMessage,
  type RunSummary,
} from "./inbox.js";
import { defineTool, type Tool } from "../tools/types.js";
import { gitSnapshot } from "./snapshot.js";
import { createTeamTools } from "../teams/delegate.js";
import { steerDirective, type SteerChannel } from "../teams/steer.js";
import type { TeamRole } from "../teams/types.js";
import { TraceFanout } from "../trace/sink.js";
import {
  budgetWarning,
  revivalBlock,
  warnPercent as revivalWarnPercent,
} from "./revival.js";
import { phaseDisciplineBlock } from "./phase-discipline.js";
import { renderPromptBlocks, type PromptBlock } from "./prompt.js";
import {
  addRequirement,
  compileLedger,
  createLedger,
  ledgerGate,
  linkEvidence,
  readyRequirements,
  recordEvidence,
  renderLedger,
  setRequirementStatus,
  unmetDependencies,
  type VerifierConfig,
} from "../ledger/index.js";
import { llmJudge, type Judge, type JudgeVerdict } from "../verify/index.js";
import type {
  LedgerEvidenceRef,
  ProgressLedger,
} from "../ledger/types.js";
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
  wrapUpNudge,
} from "./guardrails.js";
import {
  CANCEL_GRACE,
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_STALL_AFTER_MS,
  waitWithCancelGrace,
} from "./supervision.js";
import type {
  RunInput,
  EngineOptions,
  AgentResult,
  BackgroundJob,
  FinishReason,
  WorkerProgress,
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
  RunInput,
  EngineOptions,
  AgentResult,
  FinishReason,
  GuardrailConfig,
  WorkerProgress,
} from "./types.js";
export { userTurn } from "./types.js";

/**
 * Ledger tools answer "what is the task", not "what did the work". Calling one
 * must never be captured as evidence about the work inside the ledger it
 * manages. These are the split
 * successors.
 */
const LEDGER_TOOL_NAMES = new Set([
  "create_task",
  "finish",
  "add_requirement",
  "set_requirement_status",
  "link_evidence",
  "verify_requirement",
  "set_next_step",
  "add_failure",
  "clear_failure",
]);

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
  /** Agent name for trace attribution. */
  agent?: string;
  /** Parent agent when this is a delegated child run. */
  parentAgent?: string;
  /** Tool-call id of the delegate invocation. */
  delegateCallId?: string;
  /** Worker instance of a delegated child ("frontend-2"); `agent` is its member. */
  worker?: string;
  /** Team role of a delegated child. */
  role?: TeamRole;
  /**
   * A delegated child: its budget is its own, it wraps up at the soft cap, and
   * running out ends it with a partial hand-back instead of the leader's
   * budget reasons. Absent for the leader and for standalone runs.
   */
  child?: true;
  /** Leader directives for this child, drained at each turn boundary. */
  steer?: SteerChannel;
}

/** The child's most recent visible prose, for a budget-exhausted hand-back. */
function lastAssistantText(messages: LLMMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (
      message.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.trim()
    ) {
      return message.content.trim();
    }
  }
  return "";
}

/**
 * The last non-empty line of the child's most recent visible prose, capped for
 * a progress record: what a wake-up message can quote as "it was doing X".
 */
function lastAssistantLine(messages: LLMMessage[], max = 200): string {
  const full = lastAssistantText(messages);
  if (!full) return "";
  const line =
    full
      .split("\n")
      .map((row) => row.trim())
      .filter(Boolean)
      .pop() ?? "";
  return line.length > max ? line.slice(0, max) : line;
}

/**
 * Paths named by a turn's tool calls, for progress. Best-effort: an
 * unparseable call contributes nothing, so this can never fail a run.
 */
function noteTouchedFiles(target: Set<string>, calls: LLMToolCall[]): void {
  for (const call of calls) {
    try {
      const parsed: unknown = call.arguments.trim()
        ? JSON.parse(call.arguments)
        : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const path = (parsed as Record<string, unknown>).path;
        if (typeof path === "string" && path.trim()) target.add(path.trim());
      }
    } catch {
      /* an unparseable call is not a file path */
    }
  }
}

/** "…, 3/20 steps, $0.42/$1.50" — the numbers a wrap-up nudge cites. */
function budgetLine(budget: BudgetTracker, steps: number): string {
  const parts = [`${steps}/${budget.limits.maxSteps} steps`];
  if (budget.limits.maxWallClockMs !== undefined)
    parts.push(`${Math.round(budget.wallClockMs() / 1000)}s/${Math.round(budget.limits.maxWallClockMs / 1000)}s`);
  if (budget.costsKnown) parts.push(`$${budget.costUsd.toFixed(2)}/$${budget.limits.maxUsd}`);
  return parts.join(", ");
}

async function runOne(
  input: RunInput,
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
  // The signal every tool sees. It is the run's cancel signal plus, for a
  // delegated child, its own wall-clock deadline: a tool call already in
  // flight is aborted at the deadline, and the child concludes
  // `budget_exhausted` with a partial hand-back. The run signal (used for the
  // model call) stays separate, so a deadline never reads as a host cancel.
  const toolController = new AbortController();
  const toolSignal = toolController.signal;
  const abortTools = () => toolController.abort();
  if (signal.aborted) toolController.abort();
  else signal.addEventListener("abort", abortTools, { once: true });
  const timers: Array<
    ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>
  > = [];
  const fanout = opts.traceSinks?.length
    ? new TraceFanout(opts.traceSinks)
    : null;
  let stopped = false;
  /** Idempotent: stop the timers, unlink the signals, flush sinks. */
  const stopLifecycle = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    opts.signal?.removeEventListener("abort", abortFromCaller);
    signal.removeEventListener("abort", abortTools);
    if (fanout) await fanout.flush();
  };
  const traceAttribution = {
    ...(chain.agent ? { agent: chain.agent } : {}),
    ...(chain.parentAgent ? { parentAgent: chain.parentAgent } : {}),
    ...(chain.delegateCallId ? { delegateCallId: chain.delegateCallId } : {}),
    ...(chain.worker ? { worker: chain.worker } : {}),
    ...(chain.role ? { role: chain.role } : {}),
  };
  // Activity bookkeeping for a delegated child's stall signal. Every event the
  // child produces is activity; the one record this emits for a silent child
  // is not.
  let lastActivityAt = Date.now();
  let stallReported = false;
  let lastToolName: string | undefined;
  let lastVerbName: string | undefined;
  const emit: EventSink = (event) => {
    const attributed =
      Object.keys(traceAttribution).length > 0
        ? { ...event, ...traceAttribution }
        : event;
    fanout?.record(attributed);
    try {
      opts.onEvent?.(attributed);
    } catch {
      // A subscriber must never kill the run — same rule as sinks.
    }
    if (event.type === "progress" && event.stalled) return;
    lastActivityAt = Date.now();
    stallReported = false;
    if (event.type === "tool_call") {
      lastToolName = event.name;
      lastVerbName = event.verb ?? event.name;
    }
  };
  if (opts.repos?.length) {
    if (!opts.sandbox) throw new Error("EngineOptions.repos requires a sandbox");
    validateRepos(opts.repos, opts.sandbox.workspace);
  }
  const tools = opts.tools ?? opts.agent?.tools ?? [];
  const available = new Map(tools.map((tool) => [tool.definition.name, tool]));
  /** The context every tool gets — including the host's background policy. */
  const toolContext = {
    sandbox: opts.sandbox,
    ...(opts.repos?.length ? { repos: opts.repos } : {}),
    ...(opts.backgroundAfterSecs !== undefined
      ? { backgroundAfterSecs: opts.backgroundAfterSecs }
      : {}),
    ...(chain.worker && chain.agent && chain.role
      ? { team: { worker: chain.worker, member: chain.agent, role: chain.role } }
      : {}),
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
  /**
   * Phases are on only when there is a choice to make and the consumer did not
   * switch the intrinsic off. Off means off everywhere: no set_phase, no
   * discipline or "Current phase" prompt, no phase events, and no phase in the
   * hand-back or the thread record, so a phase the model can never change is
   * never presented to it as an instruction.
   */
  const phaseOn =
    strategy.phases.length > 1 && opts.intrinsics?.phase !== false;
  /** The phase tag for events and results; absent when phases are off. */
  const phaseTag = () => (phaseOn ? { phase } : {});
  if (
    opts.startPhase &&
    !strategy.phases.some((p) => p.id === opts.startPhase)
  ) {
    throw new Error(
      `startPhase "${opts.startPhase}" is not a phase of strategy "${strategy.name}"`,
    );
  }
  const requestText = input.messages
    .filter((message) => message.role === "user" && message.content?.trim())
    .map((message) => message.content!)
    .join("\n\n");
  const context =
    input.context ?? (await strategy.prepareContext?.(opts.sandbox, requestText));
  const prior = await opts.thread?.store.load(opts.thread.id);
  if (
    phaseOn &&
    !opts.startPhase &&
    prior?.phase &&
    strategy.phases.some((item) => item.id === prior.phase)
  )
    phase = prior.phase;
  let summary = prior?.summary;
  let compaction = prior?.compaction;

  const budget = chain.budget ?? new BudgetTracker(opts.budgets);
  const cancelGraceMs = opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const stallAfterMs =
    opts.stallAfterMs === false
      ? false
      : (opts.stallAfterMs ?? DEFAULT_STALL_AFTER_MS);
  // A child's wall-clock budget must bite at its next tool boundary, not only
  // at turn boundaries: give its tools a signal that aborts at the deadline,
  // so a call already in flight is cut and no new call starts past it.
  const wallClockLimit = budget.limits.maxWallClockMs;
  if (chain.child && wallClockLimit !== undefined && wallClockLimit > 0) {
    const remainingMs = Math.max(0, wallClockLimit - budget.wallClockMs());
    const deadline = setTimeout(() => toolController.abort(), remainingMs);
    deadline.unref?.();
    timers.push(deadline);
  }

  // ---- Task contracts and the judge --------------------------------------
  const verifierOn = opts.verifier !== undefined && opts.verifier !== false;
  const verifierConfig: VerifierConfig =
    verifierOn && typeof opts.verifier === "object" ? opts.verifier : {};
  const verifierGates = new Set(
    verifierConfig.gates ?? ["phase", "finish"],
  );
  const judge: Judge | undefined = verifierOn
    ? (verifierConfig.judge ?? llmJudge(verifierConfig.llm ?? opts.llm))
    : undefined;
  const maxJudgeCalls = verifierConfig.maxCallsPerTask ?? 8;
  const maxPhaseRejections = verifierConfig.maxRejectionsPerPhase ?? 3;
  let judgeCalls = 0;
  let phaseRejections = 0;
  let phaseEvidence: LedgerEvidenceRef[] = [];
  const contractTaskId =
    opts.taskId ?? opts.thread?.id ?? `task-${Date.now()}`;
  let ledger = opts.ledger ?? (verifierOn ? prior?.ledger : undefined);
  // A settled ledger is history, not an active contract — unless the caller
  // offers it for extension (follow-up work on a task that just finished).
  if (ledger && !hasActiveLedger(ledger) && !opts.extendLedger) ledger = undefined;

  const callJudge = async (
    phaseGoal: { id: string; goal: string; guidance?: string },
    requirements: ProgressLedger["requirements"],
    agentReason?: string,
  ): Promise<JudgeVerdict | undefined> => {
    if (!judge || !ledger || judgeCalls >= maxJudgeCalls) return undefined;
    judgeCalls += 1;
    try {
      const verdict = await judge.judge(
        {
          request: requestText,
          phase: phaseGoal,
          ledger,
          evidenceSincePhase: [...phaseEvidence],
          ...(agentReason ? { agentReason } : {}),
        },
        signal,
      );
      if (verdict.usage) budget.record(verdict.usage);
      const wanted = new Set(requirements.map((item) => item.id));
      const judged = verdict.requirements.filter((item) =>
        wanted.has(item.id),
      );
      emit({
        type: "phase_verdict",
        phase: phaseGoal.id,
        cleared: verdict.cleared,
        confidence: verdict.confidence,
        judge: judge.name,
        requirements: judged.map((item) => ({
          id: item.id,
          status: item.status,
          ...(item.probability !== undefined
            ? { probability: item.probability }
            : {}),
        })),
      });
      return verdict;
    } catch (error) {
      emit({
        type: "advisory",
        kind: "verifier_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      if (verifierConfig.onError === "block") {
        return {
          cleared: false,
          requirements: requirements.map((item) => ({
            id: item.id,
            status: "unproven" as const,
          })),
          confidence: 0,
        };
      }
      return undefined;
    }
  };

  // The task contract, one tool per operation. A single `update_ledger` with an
  // `op` and every field anyone might need let models mix operations up: an
  // "add" carrying `status`, `failure` and an existing id, repeated verbatim
  // until the engine stalled the turn. Each tool below does one job and asks
  // for only the fields that job needs; the old shim is gone.
  const runLedgerOp = async (
    op: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> => {
        const dependencyError = (requirementId: string): string | undefined => {
          const requirement = ledger!.requirements.find(
            (item) => item.id === requirementId,
          );
          if (!requirement) return `unknown requirement "${requirementId}"`;
          const unmet = unmetDependencies(ledger!, requirement, {
            allowWaived: verifierConfig.allowWaived,
          });
          return unmet.length
            ? `${requirement.id} requires ${unmet.join(", ")}`
            : undefined;
        };
        if (op === "add_requirement") {
          const text = String(input.text ?? "").trim();
          if (!text)
            return {
              ok: false,
              content:
                'add_requirement needs text: the requirement in one sentence, e.g. {"op":"add_requirement","text":"Threads can be filtered by label","dependsOn":["r2"]}',
            };
          if (input.id !== undefined && typeof input.id !== "string") {
            return { ok: false, content: "id must be a string" };
          }
          if (input.dependsOn !== undefined && !Array.isArray(input.dependsOn)) {
            return {
              ok: false,
              content: "dependsOn must be an array of requirement ids",
            };
          }
          if (
            Array.isArray(input.dependsOn) &&
            input.dependsOn.some((item) => typeof item !== "string")
          ) {
            return {
              ok: false,
              content: "dependsOn must be an array of requirement ids",
            };
          }
          try {
            const requirement = addRequirement(
              ledger!,
              {
                text,
                required: input.required !== false,
                ...(typeof input.id === "string" && input.id
                  ? { id: input.id }
                  : {}),
                ...(typeof input.phase === "string" && input.phase
                  ? { phase: input.phase }
                  : {}),
                ...(Array.isArray(input.dependsOn) && input.dependsOn.length
                  ? { dependsOn: input.dependsOn as string[] }
                  : {}),
              },
              "agent",
            );
            return {
              ok: true,
              content: `added ${requirement.id}: ${requirement.text}`,
            };
          } catch (error) {
            return {
              ok: false,
              content: error instanceof Error ? error.message : String(error),
            };
          }
        }
        if (op === "link_evidence") {
          const claim = String(input.claim ?? "").trim();
          if (!claim) {
            return {
              ok: false,
              content: "claim is required: explain why this evidence establishes the requirement",
            };
          }
          linkEvidence(
            ledger!,
            String(input.requirementId ?? ""),
            String(input.evidenceId ?? ""),
            claim,
          );
          return { ok: true, content: "evidence linked" };
        }
        if (op === "verify") {
          const claim = String(input.claim ?? "").trim();
          if (!claim) {
            return {
              ok: false,
              content: "claim is required: explain why this evidence establishes the requirement",
            };
          }
          const requirementId = String(input.requirementId ?? "");
          const unmet = dependencyError(requirementId);
          if (unmet) return { ok: false, content: unmet };
          linkEvidence(
            ledger!,
            requirementId,
            String(input.evidenceId ?? ""),
            claim,
          );
          setRequirementStatus(ledger!, requirementId, "verified");
          return { ok: true, content: "evidence linked and requirement verified" };
        }
        if (op === "set_status") {
          const status = String(input.status ?? "");
          if (status === "superseded") {
            return { ok: false, content: "use a user revision to supersede" };
          }
          const requirementId = String(input.requirementId ?? "");
          if (status === "verified" || status === "waived") {
            const unmet = dependencyError(requirementId);
            if (unmet) return { ok: false, content: unmet };
          }
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
          if (!failure)
            return {
              ok: false,
              content: 'add_failure needs failure: what failed, in words, e.g. {"op":"add_failure","failure":"Migration fails on an empty table"}',
            };
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
  };

  const requirementProps = {
    requirementId: {
      type: "string",
      description: "The existing requirement, e.g. r2.",
    },
    evidenceId: {
      type: "string",
      description: "An evidence id from a tool result. Never invented.",
    },
    claim: {
      type: "string",
      description:
        "Why this evidence establishes the requirement, in one sentence.",
    },
  } as const;

  const ledgerTools = () => {
    const install = (tool: Tool, name: string) => {
      available.set(name, tool);
      return tool;
    };
    install(
      defineTool(
        {
          name: "add_requirement",
          description:
            "Add one requirement to the task contract. Use this only to add; to change an existing one use set_requirement_status, link_evidence, verify_requirement or add_failure.",
          parameters: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: "What must be true, in one sentence.",
              },
              id: {
                type: "string",
                description: "The new requirement's id (e.g. r3). Omit for the next one.",
              },
              phase: {
                type: "string",
                description: "The phase that satisfies it.",
              },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                description: "Ids of requirements that must be met first.",
              },
              required: {
                type: "boolean",
                description: "false for a nice-to-have. Default true.",
              },
            },
            required: ["text"],
            additionalProperties: false,
          },
        },
        (input) => runLedgerOp("add_requirement", input as Record<string, unknown>),
        { verb: "Adding a requirement" },
      ),
      "add_requirement",
    );
    install(
      defineTool(
        {
          name: "set_requirement_status",
          description:
            "Change an existing requirement's status. Marking one verified needs evidence linked first.",
          parameters: {
            type: "object",
            properties: {
              requirementId: requirementProps.requirementId,
              status: {
                type: "string",
                enum: ["open", "in_progress", "verified", "blocked", "waived"],
                description: "The requirement's new status.",
              },
            },
            required: ["requirementId", "status"],
            additionalProperties: false,
          },
        },
        (input) => runLedgerOp("set_status", input as Record<string, unknown>),
        { verb: "Setting a requirement's status" },
      ),
      "set_requirement_status",
    );
    install(
      defineTool(
        {
          name: "link_evidence",
          description:
            "Attach a tool result to a requirement, with a sentence saying why it shows it.",
          parameters: {
            type: "object",
            properties: requirementProps,
            required: ["requirementId", "evidenceId", "claim"],
            additionalProperties: false,
          },
        },
        (input) => runLedgerOp("link_evidence", input as Record<string, unknown>),
        { verb: "Linking evidence" },
      ),
      "link_evidence",
    );
    install(
      defineTool(
        {
          name: "verify_requirement",
          description:
            "Link a tool result to a requirement and mark it verified, in one step.",
          parameters: {
            type: "object",
            properties: requirementProps,
            required: ["requirementId", "evidenceId", "claim"],
            additionalProperties: false,
          },
        },
        (input) => runLedgerOp("verify", input as Record<string, unknown>),
        { verb: "Verifying a requirement" },
      ),
      "verify_requirement",
    );
    install(
      defineTool(
        {
          name: "set_next_step",
          description: "Record the next step you are about to take.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "The next step." },
            },
            required: ["text"],
            additionalProperties: false,
          },
        },
        (input) => runLedgerOp("set_next_step", input as Record<string, unknown>),
        { verb: "Recording the next step" },
      ),
      "set_next_step",
    );
    install(
      defineTool(
        {
          name: "add_failure",
          description: "Record something that failed and still needs fixing.",
          parameters: {
            type: "object",
            properties: {
              failure: { type: "string", description: "What failed, in words." },
            },
            required: ["failure"],
            additionalProperties: false,
          },
        },
        (input) => runLedgerOp("add_failure", input as Record<string, unknown>),
        { verb: "Recording a failure" },
      ),
      "add_failure",
    );
    install(
      defineTool(
        {
          name: "clear_failure",
          description: "Clear a failure once it is fixed.",
          parameters: {
            type: "object",
            properties: {
              failure: {
                type: "string",
                description: "The recorded failure, word for word.",
              },
            },
            required: ["failure"],
            additionalProperties: false,
          },
        },
        (input) => runLedgerOp("clear_failure", input as Record<string, unknown>),
        { verb: "Clearing a failure" },
      ),
      "clear_failure",
    );
    return available.get("add_requirement")!;
  };

  const installCompletionGate = () => {
    completionGate = async (summaryText, success) => {
      const active = ledger!;
      const structural = ledgerGate(active, {
        allowWaived: verifierConfig.allowWaived,
      });
      if (!structural.allow) {
        if (!success) {
          // The agent explicitly reported a blocked/unsuccessful outcome. End
          // honestly instead of forcing it into the stalled path.
          for (const id of [...structural.open, ...structural.missingEvidence]) {
            const requirement = active.requirements.find((item) => item.id === id);
            if (requirement) {
              const note = `${id}: ${requirement.text}`;
              if (!active.openFailures.includes(note)) active.openFailures.push(note);
            }
          }
          for (const failure of structural.failures) {
            if (!active.openFailures.includes(failure)) {
              active.openFailures.push(failure);
            }
          }
          return { ok: true, content: "" };
        }
        return {
          ok: false,
          content: [
            "Verification gate: required work is not complete.",
            `open: ${structural.open.join(", ") || "none"}`,
            `missingEvidence: ${structural.missingEvidence.join(", ") || "none"}`,
            `unsatisfiedDependencies: ${structural.unsatisfiedDependencies.join(" | ") || "none"}`,
            `failures: ${structural.failures.join(" | ") || "none"}`,
            "Attach evidence to each requirement with link_evidence or verify_requirement, resolve failures, and try again.",
          ].join("\n"),
        };
      }
      if (!success) return { ok: true, content: "" };
      if (!verifierGates.has("finish")) {
        verified = true;
        return { ok: true, content: "" };
      }
      const required = active.requirements.filter(
        (item) => item.required && item.status !== "superseded",
      );
      const verdict = await callJudge(
        { id: "finish", goal: "Deliver the task outcome with evidence." },
        required,
        summaryText,
      );
      if (!verdict) {
        verified = verifierConfig.onError !== "block";
        return verified
          ? { ok: true, content: "" }
          : {
              ok: false,
              content:
                "Verification gate unavailable and onError is block; retry the judge before finishing.",
            };
      }
      const wanted = new Set(required.map((item) => item.id));
      const unmet = verdict.requirements.filter(
        (item) => wanted.has(item.id) && item.status !== "cleared",
      );
      if (verdict.cleared && unmet.length === 0) {
        verified = true;
        return { ok: true, content: "" };
      }
      const details = unmet.map((item) => {
        const requirement = active.requirements.find((r) => r.id === item.id);
        const claim = requirement?.evidenceIds
          .map((id) => active.evidence[id]?.claim)
          .find(Boolean);
        const probability =
          item.probability !== undefined
            ? ` p=${item.probability.toFixed(2)}`
            : "";
        return `${item.id}${probability} ${item.status}: ${requirement?.text ?? "unknown requirement"}${claim ? `; claim: ${claim}` : ""}`;
      });
      return {
        ok: false,
        content:
          `Verification gate rejected completion: ${verdict.rationale ?? "unsupported claim"}.\n` +
          (details.length
            ? `Unmet requirements:\n${details.join("\n")}`
            : "The judge did not clear the contract."),
      };
    };
  };

  const attachLedger = (next: ProgressLedger) => {
    ledger = next;
    phaseRejections = 0;
    phaseEvidence = [];
    ledgerTools();
    installCompletionGate();
  };
  if (verifierOn && ledger) attachLedger(ledger);
  else if (verifierOn && verifierConfig.create === "start") {
    const compiled = await compileLedger({
      llm: verifierConfig.llm ?? opts.llm,
      taskId: contractTaskId,
      source: requestText,
      phases: strategy.phases,
      reasoningEffort: "low",
    });
    if (compiled.usage) budget.record(compiled.usage);
    attachLedger(compiled.ledger);
  }

  const currentRequests = input.messages;
  const revivalOn = !!opts.revival;
  const revivalWarnAt = revivalWarnPercent(
    opts.revival ? opts.revival.warnAtPercent : undefined,
  );
  let revivalWarned = false;
  let revivalRequest: RevivalRequest | undefined;
  /**
   * Stable blocks are the cacheable prefix; turn-scoped blocks are appended
   * after the conversation. The ledger changes after every tool result, so it
   * must never live in the system message.
   */
  const promptBlocks = (): PromptBlock[] => [
    {
      id: "agent",
      text: strategy.systemPrompt({ context, summary }),
      stability: "stable",
    },
    {
      id: "phase-discipline",
      text: phaseOn ? phaseDisciplineBlock(strategy.phases) : undefined,
      stability: "stable",
    },
    {
      id: "budget-revival",
      text: revivalOn ? revivalBlock(revivalWarnAt) : undefined,
      stability: "stable",
    },
    {
      id: "ledger",
      text: ledger
        ? [
            "## Runtime task state",
            "This is authoritative state, not a new user request.",
            renderLedger(ledger, {
              allowWaived: verifierConfig.allowWaived,
            }),
            "Use link_evidence and verify_requirement for each requirement. Do not claim completion while a required item is open or lacks evidence.",
          ].join("\n\n")
        : undefined,
      stability: "turn",
    },
    {
      id: "compaction",
      text: compaction ? renderCompactionHandoff(compaction) : undefined,
      stability: "turn",
    },
    {
      id: "phase-state",
      text: phaseOn && phase ? `Current phase: ${phase}` : undefined,
      stability: "turn",
    },
  ];
  const system = () => ({
    role: "system" as const,
    content: renderPromptBlocks(promptBlocks(), "stable"),
  });
  const turnState = () => renderPromptBlocks(promptBlocks(), "turn");

  const messages: LLMMessage[] = [
    system(),
    ...conversationHistory(prior?.messages ?? []),
    ...currentRequests,
  ];
  const compact =
    opts.compaction === false
      ? null
      : { ...DEFAULT_COMPACTION, ...opts.compaction };
  // The model's view of the transcript, bounded by assistant-text elision
  // (#77). `messages` stays whole — this only changes what is SENT.
  const elidedByMessage = new WeakMap<LLMMessage, LLMMessage>();
  const forModel = (includeTurn = true): LLMMessage[] => {
    const out = messages.map((m) => elidedByMessage.get(m) ?? m);
    if (!includeTurn) return out;
    const turn = turnState();
    if (turn) {
      // Keep the turn's final message last (tests and tool protocol both rely
      // on it); put the changing runtime state immediately before it so the
      // stable prefix is still reused.
      const insertAt = Math.max(1, out.length - 1);
      out.splice(insertAt, 0, {
        role: "user",
        content: turn,
      });
    }
    return out;
  };
  /**
   * Cache the stable prefix, never the turn-scoped block. The adapter only
   * emits `cache_control` when the consumer enabled `promptCache`.
   */
  const cacheBreakpointsFor = (modelMessages: LLMMessage[]): number[] => {
    const markable = (message: LLMMessage | undefined): boolean =>
      !!message &&
      (message.role === "system" ||
        message.role === "user" ||
        (message.role === "assistant" && !!message.content));
    const indexes = new Set<number>();
    if (markable(modelMessages[0])) indexes.add(0);
    const turn = turnState();
    const turnIndex = turn
      ? modelMessages.findIndex(
          (message) =>
            message.role === "user" && message.content === turn,
        )
      : -1;
    let end = turnIndex > 0 ? turnIndex - 1 : modelMessages.length - 1;
    while (end >= 0 && !markable(modelMessages[end])) end--;
    if (end >= 0) indexes.add(end);
    return [...indexes];
  };
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

  // ---- Delegated subagents ------------------------------------------------
  // Registered here, after the step counters exist: a child's derived budget
  // is computed from what the leader has left at the moment it delegates.
  if (opts.team && Object.keys(opts.team.members).length > 0) {
    const remaining = () => ({
      steps: Math.max(0, budget.limits.maxSteps - stepsBefore - steps),
      ...(budget.limits.maxWallClockMs !== undefined
        ? { wallClockMs: Math.max(0, budget.limits.maxWallClockMs - budget.wallClockMs()) }
        : {}),
      usd: budget.costsKnown
        ? Math.max(0, budget.limits.maxUsd - budget.costUsd)
        : budget.limits.maxUsd,
    });
    const teamTools = createTeamTools({
      team: opts.team,
      parent: opts,
      budget,
      remaining,
      leaderName: strategy.name,
      emit,
      signal,
      runChild: (input, childOpts, link) => runOne(input, childOpts, link),
    });
    available.set("delegate", teamTools.delegate);
    available.set("steer_worker", teamTools.steer);
  }

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
                ...phaseTag(),
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
  // A delegated child is told to wrap up once, at its soft cap. The hard cap
  // still ends the loop; the flag keeps the directive one-shot.
  let softCapNudged = false;
  /** Files the child has named in its tool calls, for progress. */
  const touchedFiles = new Set<string>();
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
  /**
   * The compact record a host sees while a delegated child runs. One shape for
   * the per-turn progress and for the stall signal, so a supervisor reads the
   * same fields either way.
   */
  const emitProgress = (
    extra: { stalled?: boolean; stalledForMs?: number } = {},
  ): void => {
    if (!chain.child || !chain.worker) return;
    const filesTouched = touchedFiles.size
      ? [...touchedFiles].slice(0, 20)
      : undefined;
    const lastText = lastAssistantLine(messages);
    const progress: WorkerProgress = {
      worker: chain.worker,
      agent: chain.agent ?? strategy.name,
      role: chain.role ?? "worker",
      steps,
      budgetUsed: budget.usedFraction(stepsBefore + steps),
      ...(lastToolName ? { lastTool: lastToolName } : {}),
      ...(lastVerbName ? { lastVerb: lastVerbName } : {}),
      ...(lastText ? { lastText } : {}),
      ...(filesTouched ? { filesTouched } : {}),
      ...(extra.stalled ? { stalled: true } : {}),
      ...(extra.stalledForMs !== undefined
        ? { stalledForMs: extra.stalledForMs }
        : {}),
      steer: (value) => chain.steer?.push(value) ?? false,
      nudge: (value) => chain.steer?.push(value) ?? false,
    };
    emit({
      type: "progress",
      worker: progress.worker,
      steps: progress.steps,
      budgetUsed: progress.budgetUsed,
      ...(progress.lastTool ? { lastTool: progress.lastTool } : {}),
      ...(progress.lastVerb ? { lastVerb: progress.lastVerb } : {}),
      ...(progress.lastText ? { lastText: progress.lastText } : {}),
      ...(progress.filesTouched ? { filesTouched: progress.filesTouched } : {}),
      ...(progress.stalled ? { stalled: true } : {}),
      ...(progress.stalledForMs !== undefined
        ? { stalledForMs: progress.stalledForMs }
        : {}),
    });
    try {
      opts.onProgress?.(progress);
    } catch {
      // A consumer callback must never kill the run.
    }
  };
  // A child that produces no event for `stallAfterMs` is reported ONCE; any
  // real activity resets the window. The engine neither cancels nor nudges —
  // the supervisor decides.
  if (chain.child && chain.worker && stallAfterMs !== false) {
    const tick = setInterval(() => {
      const idle = Date.now() - lastActivityAt;
      if (idle < stallAfterMs || stallReported) return;
      stallReported = true;
      emitProgress({ stalled: true, stalledForMs: idle });
    }, stallAfterMs);
    tick.unref?.();
    timers.push(tick);
  }
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
          let forced = false;
          if (target.id !== previous && ledger && verifierGates.has("phase")) {
            const owned = ledger.requirements.filter(
              (item) =>
                item.required &&
                item.phase === previous &&
                item.status !== "verified" &&
                item.status !== "waived" &&
                item.status !== "superseded",
            );
            if (owned.length > 0) {
              const outgoing =
                strategy.phases.find((item) => item.id === previous) ?? {
                  id: previous,
                  goal: previous,
                };
              const verdict = await callJudge(
                outgoing,
                owned,
                typeof input.reason === "string" ? input.reason : undefined,
              );
              const wanted = new Set(owned.map((item) => item.id));
              const unmet = verdict
                ? verdict.requirements.filter(
                    (item) =>
                      wanted.has(item.id) && item.status !== "cleared",
                  )
                : [];
              if (verdict && (!verdict.cleared || unmet.length > 0)) {
                phaseRejections += 1;
                const details = unmet.map((item) => {
                  const requirement = ledger!.requirements.find(
                    (row) => row.id === item.id,
                  );
                  const claim = requirement?.evidenceIds
                    .map((id) => ledger!.evidence[id]?.claim)
                    .find(Boolean);
                  const probability =
                    item.probability !== undefined
                      ? ` p=${item.probability.toFixed(2)}`
                      : "";
                  return `${item.id}${probability} ${item.status}: ${requirement?.text ?? "unknown requirement"}${claim ? `; claim: ${claim}` : ""}`;
                });
                const detail =
                  `Phase ${previous} has unmet requirements.` +
                  (details.length ? `\n${details.join("\n")}` : "");
                emit({
                  type: "guardrail",
                  kind: "transition_rejected",
                  detail: `${previous} -> ${target.id}: ${detail}`,
                });
                if (phaseRejections <= maxPhaseRejections) {
                  return {
                    ok: false,
                    content: [
                      `Phase transition rejected: ${previous} is not complete.`,
                      ...(details.length ? details : ["The judge did not clear the phase."]),
                      `Stay in ${previous}, finish the owned requirements, then transition again.`,
                    ].join("\n"),
                  };
                }
                for (const item of owned) {
                  if (item.status !== "blocked" && item.status !== "verified") {
                    setRequirementStatus(ledger!, item.id, "in_progress");
                  }
                }
                forced = true;
                emit({
                  type: "guardrail",
                  kind: "transition_rejected",
                  detail: `forcing ${previous} -> ${target.id} after ${phaseRejections} rejection(s); requirements remain open and finish is still gated`,
                });
              }
            }
          }
          phase = target.id;
          phaseRejections = 0;
          phaseEvidence = [];
          pauseRequested =
            opts.pauseAfterPhase === previous && previous !== phase;
          emit({
            type: "phase_started",
            phase,
            ...(forced ? { via: "advance_forced" as const } : {}),
          });
          return {
            ok: true,
            content: `Current approach: ${target.id} — ${target.goal}`,
            meta: {
              phase,
              previous,
              ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
            },
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

  if (verifierOn && opts.intrinsics?.task !== false) {
    available.set(
      "create_task",
      defineTool(
        {
          name: "create_task",
          description:
            "Create the task contract for this turn when the user asked for real work. " +
            "State a measurable goal and 1-30 independently checkable requirements, each assigned " +
            "to one of the strategy's phases. Do not include a source field; the engine derives " +
            "the authoritative request from the user's messages.",
          parameters: {
            type: "object",
            properties: {
              goal: { type: "string" },
              requirements: {
                type: "array",
                minItems: 1,
                maxItems: 30,
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    text: { type: "string" },
                    required: { type: "boolean" },
                    phase: {
                      type: "string",
                      enum: strategy.phases.map((item) => item.id),
                    },
                    sourceQuote: { type: "string" },
                    dependsOn: { type: "array", items: { type: "string" } },
                  },
                  required: ["text", "phase"],
                  additionalProperties: false,
                },
              },
              nextStep: { type: "string" },
            },
            required: ["goal", "requirements"],
            additionalProperties: false,
          },
        },
        async (input) => {
          if (ledger) {
            return {
              ok: false,
              content:
                "the contract is already active; use set_requirement_status or add_requirement to change it",
            };
          }
          const goal = String(input.goal ?? "").trim();
          if (!goal) return { ok: false, content: "goal is required" };
          const rows = Array.isArray(input.requirements)
            ? input.requirements
            : [];
          if (rows.length < 1 || rows.length > 30) {
            return {
              ok: false,
              content: "requirements must contain 1-30 items",
            };
          }
          const phaseIds = new Set(strategy.phases.map((item) => item.id));
          const requirements: Array<{
            id?: string;
            text: string;
            required: boolean;
            phase: string;
            sourceQuote?: string;
            dependsOn?: string[];
          }> = [];
          for (const [index, row] of rows.entries()) {
            if (!row || typeof row !== "object" || Array.isArray(row)) {
              return {
                ok: false,
                content: `requirement ${index} must be an object`,
              };
            }
            const entry = row as Record<string, unknown>;
            const text = String(entry.text ?? "").trim();
            const phase = String(entry.phase ?? "");
            if (!text) {
              return { ok: false, content: `requirement ${index} needs text` };
            }
            if (!phaseIds.has(phase)) {
              return {
                ok: false,
                content: `requirement ${index} has unknown phase "${phase}"`,
              };
            }
            const sourceQuote =
              typeof entry.sourceQuote === "string"
                ? entry.sourceQuote
                : undefined;
            if (sourceQuote && !requestText.includes(sourceQuote)) {
              return {
                ok: false,
                content: `requirement ${index} sourceQuote is not in the user's request`,
              };
            }
            if (entry.id !== undefined && typeof entry.id !== "string") {
              return {
                ok: false,
                content: `requirement ${index} id must be a string`,
              };
            }
            if (
              entry.dependsOn !== undefined &&
              (!Array.isArray(entry.dependsOn) ||
                entry.dependsOn.some((item) => typeof item !== "string"))
            ) {
              return {
                ok: false,
                content: `requirement ${index} dependsOn must be an array of requirement ids`,
              };
            }
            const id =
              typeof entry.id === "string" && entry.id.trim()
                ? entry.id.trim()
                : undefined;
            requirements.push({
              ...(id ? { id } : {}),
              text,
              required: entry.required !== false,
              phase,
              ...(sourceQuote ? { sourceQuote } : {}),
              ...(Array.isArray(entry.dependsOn) && entry.dependsOn.length
                ? { dependsOn: entry.dependsOn as string[] }
                : {}),
            });
          }
          let next: ProgressLedger;
          try {
            next = createLedger({
              taskId: contractTaskId,
              source: { kind: "user", text: requestText },
              goal,
              requirements: requirements.map((item) => ({
                ...item,
                origin: "agent" as const,
              })),
            });
          } catch (error) {
            return {
              ok: false,
              content: error instanceof Error ? error.message : String(error),
            };
          }
          if (typeof input.nextStep === "string" && input.nextStep.trim()) {
            next.nextStep = input.nextStep.trim();
          }
          attachLedger(next);
          emit({ type: "task_created", ledger: next });
          return {
            ok: true,
            content: [
              `Contract created: ${next.goal}`,
              ...next.requirements.map(
                (item) => `${item.id}: ${item.text} (phase ${item.phase ?? "any"})`,
              ),
              "Use link_evidence or verify_requirement to attach evidence with a claim and verify each requirement.",
            ].join("\n"),
            // Identifiers only: the ledger itself is emitted on task_created
            // and must never ride a tool result, which is captured as evidence
            // inside that same ledger.
            meta: {
              taskId: next.taskId,
              requirements: next.requirements.map((item) => item.id),
              ready: readyRequirements(next, {
                allowWaived: verifierConfig.allowWaived,
              }),
            },
          };
        },
        { verb: "Creating the task contract" },
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
        // A consumer's explicit resume phase (handoff.threadPhase) is its own
        // record and survives; the engine's position does only with phases on.
        phase: done ? resumePhase : phaseOn ? phase : undefined,
        ...(compaction ? { compaction } : {}),
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
      ...phaseTag(),
      evidence,
      ...(ledger ? { ledger } : {}),
      ...(compaction ? { compaction } : {}),
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
    text: requestText,
    ...(input.messages.length ? { messages: input.messages } : {}),
    phases: phaseOn ? strategy.phases.map((item) => item.id) : [],
  });
  if (chain.delivered?.length)
    emit({
      type: "inbox_delivered",
      messages: chain.delivered.map((message) => ({
        id: message.id,
        delivery: message.delivery,
      })),
    });
  if (phaseOn) emit({ type: "phase_started", phase });
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
      // Leader directives land here, at the boundary, as ordinary runtime
      // messages in the child's own stream — never a tool result, so they
      // cannot forge evidence.
      if (chain.steer) {
        for (const directive of chain.steer.drain()) {
          messages.push({
            role: "user",
            origin: "engine",
            content: steerDirective(directive),
          });
        }
      }
      // Soft cap: a child is told to wrap up at 80% of its own budget, once.
      // It is a nudge, not a stop — the child can still hand back an answer.
      if (
        chain.child &&
        !softCapNudged &&
        budget.usedFraction(stepsBefore + steps) >= DEFAULT_CHILD_SOFT_CAP
      ) {
        softCapNudged = true;
        await courseCorrect({
          kind: "child_wrap_up",
          detail:
            `step ${steps}: child reached ${Math.round(DEFAULT_CHILD_SOFT_CAP * 100)}% of its budget ` +
            `(${budgetLine(budget, stepsBefore + steps)}) — told to wrap up`,
          content: wrapUpNudge(
            Math.max(0, budget.limits.maxSteps - stepsBefore - steps),
            budgetLine(budget, stepsBefore + steps),
          ),
        });
      }
      const over = budget.exceeded(stepsBefore + steps);
      if (over) {
        emit({
          type: "guardrail",
          kind: "budget_exceeded",
          detail: over.detail,
        });
        // A child out of its OWN budget hands back what it has. The leader's
        // run continues; a worker hitting its cap is not the leader's failure.
        if (chain.child) {
          return conclude("budget_exhausted", {
            ok: false,
            summary: lastAssistantText(messages),
            error: over.detail,
          });
        }
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
        let folded = null as Awaited<
          ReturnType<typeof compactConversation>
        > | null;
        if (ledger) {
          try {
            folded = await compactConversationStructured({
              llm: opts.llm,
              messages: forModel(false),
              ...(summary ? { previousSummary: summary } : {}),
              ...(compaction ? { previousHandoff: compaction } : {}),
              ledger,
              ...(checkpointRef ? { git: { checkpoint: checkpointRef } } : {}),
              keepRecentTokens: compact.keepRecentTokens,
              signal,
            });
          } catch {
            folded = null;
          }
        }
        if (!folded) {
          folded = await compactConversation({
            llm: opts.llm,
            messages: forModel(false),
            runningSummary: summary,
            keepRecentTokens: compact.keepRecentTokens,
            signal,
          });
        }
        if (folded) {
          budget.record(folded.usage);
          if (folded.handoff) {
            compaction = folded.handoff;
            summary = undefined;
          } else {
            summary = folded.summary;
            compaction = undefined;
          }
          const tail = folded.keptMessages;
          // After a task reset the handoff is the durable record. A legacy
          // fold still points at the working-notes file.
          const foldNote = {
            role: "user" as const,
            content: folded.handoff
              ? "[runtime] Context was reset to a durable task handoff. The authoritative task, requirements, evidence, failures, next steps, and recent observations are in the turn-scoped handoff; recent messages are retained verbatim."
              : "[runtime] Context was folded to stay within the window. Your working notes " +
                "file (.anchor/notes.md, git-excluded) is the durable record of findings and " +
                "next steps — re-read it when you need detail from before the fold.",
          };
          // Preserve the actual current request even if its earlier position
          // was folded. Do not replace it with a generic "Begin" instruction.
          messages.splice(
            0,
            messages.length,
            system(),
            ...currentRequests.filter((message) => !tail.includes(message)),
            foldNote,
            ...tail,
          );
          emit({
            type: "compacted",
            removedMessages: folded.removedCount,
            keptMessages: tail.length,
            summaryChars: folded.summary.length,
            summary: folded.summary,
            ...(folded.handoff ? { compaction: folded.handoff } : {}),
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
      steps++;
      emit({ type: "llm_call_started", ...phaseTag(), step: steps });
      const modelMessages = forModel();
      const response = await waitWithCancelGrace(
        opts.llm.stream(
          {
            messages: modelMessages,
            cacheBreakpoints: cacheBreakpointsFor(modelMessages),
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
        ),
        signal,
        cancelGraceMs,
      );
      if (response === CANCEL_GRACE)
        return conclude("cancelled", {
          ok: false,
          error: "cancelled by signal",
        });
      budget.record(response.usage);
      emit({
        type: "llm_call_finished",
        ...phaseTag(),
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
      const dispatched = await waitWithCancelGrace(
        dispatchToolCalls({
          calls: response.toolCalls,
          available,
          steps,
          ...phaseTag(),
          toolContext,
          finish,
          repeat,
          messages,
          evidence,
          emit,
          emitBackground,
          ...(operationRuntime ? { operations: operationRuntime } : {}),
          onMissingJournal,
          signal: toolSignal,
          pauseRequested: () => pauseRequested,
          onToolResult: (call, result) => {
            // Contract tools describe the ledger; they are not evidence about
            // the work and must not be recorded into the ledger they manage.
            if (!ledger || LEDGER_TOOL_NAMES.has(call.name)) {
              return;
            }
            const evidenceRef = recordEvidence(ledger, {
              tool: call.name,
              ref: `call:${call.id}`,
              ok: result.ok,
              summary: result.content.replace(/\s+/g, " ").slice(0, 500),
              ...(result.meta ? { meta: result.meta } : {}),
            });
            phaseEvidence.push(evidenceRef);
          },
        }),
        signal,
        cancelGraceMs,
      );
      if (dispatched === CANCEL_GRACE)
        return conclude("cancelled", {
          ok: false,
          error: "cancelled by signal",
        });
      const outcome = dispatched;
      runaway = outcome.runaway;
      declared = outcome.declared;
      outstanding.push(...outcome.jobs);
      pendingSettlements.push(...outcome.settlements);
      // Progress for a delegated child: the leader's `delegate` call is still
      // open, so this is how a host sees the work (and may steer it). One
      // compact record per turn — never the child's transcript.
      if (chain.child && chain.worker) {
        noteTouchedFiles(touchedFiles, response.toolCalls);
        emitProgress();
      }
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

/** A required obligation still needs work, or an open failure blocks finish. */
/**
 * The op a legacy ledger call means when it names none, from the fields it
 * carries — only where they point to exactly one op. A model that sends
 * `{requirementId, status}` meant set_status; refusing it costs a turn and
 * invites the same call again.
 */
export function inferLedgerOp(input: Record<string, unknown>): string {
  const has = (key: string) => input[key] !== undefined && input[key] !== null && input[key] !== "";
  const candidates = [
    has("status") && has("requirementId") ? "set_status" : "",
    has("evidenceId") && has("requirementId") ? "link_evidence" : "",
    has("failure") ? "add_failure" : "",
    has("text") && !has("requirementId") && (has("id") || has("phase") || has("dependsOn") || has("required")) ? "add_requirement" : "",
  ].filter(Boolean);
  return candidates.length === 1 ? candidates[0]! : "";
}

function hasActiveLedger(ledger: ProgressLedger | undefined): boolean {
  if (!ledger) return false;
  return !ledgerGate(ledger).allow;
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
  input: RunInput,
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
  let current: RunInput = input;
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
    current = inbox.render ? inbox.render(batch) : renderInboxTurn(batch);
  }

  // The zero-progress guard fired. Report the last run as it stands; `.runs`
  // shows how many interruptions it took to get here.
  return { ...result!, runs };
}

export async function runAgent(
  input: RunInput,
  opts: EngineOptions,
): Promise<AgentResult> {
  if (opts.inbox) return runChain(input, opts);
  return runOne(input, opts);
}
