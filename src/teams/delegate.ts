/**
 * The leader's team tools. `delegate` hands one bounded task to one worker (an
 * instance of a roster member) and returns only its result; `steer_worker`
 * sends the leader's directive into a worker that is running right now.
 *
 * Parallelism comes from dispatch, not from here: `delegate` declares
 * `resource: delegate:<worker>`, so one leader turn that delegates to several
 * different workers runs them concurrently, while two calls to the same worker
 * run in order. `maxParallel` bounds how many are in flight at once.
 *
 * A delegation blocks the leader's model turn, so the host watches a running
 * worker through `onProgress` (and may steer it there); the `steer_worker` tool
 * exposes the same bounded channel to the leader's model.
 */
import {
  BudgetTracker,
  DEFAULT_CHILD_BUDGET_CAP,
  deriveChildBudget,
  type BudgetRemaining,
  type ChildBudget,
} from "../engine/budgets.js";
import type { EngineOptions, RunInput, AgentResult } from "../engine/types.js";
import type { EventSink } from "../engine/events.js";
import { defineTool, type Tool } from "../tools/types.js";
import {
  STEER_MAX_CHARS,
  STEER_MAX_PER_CHILD,
  createSteerChannel,
  normalizeDirective,
  type SteerChannel,
} from "./steer.js";
import { WORKER_NAME, type TeamRole, type TeamSpec } from "./types.js";

/** What the child run is told about who it is, for trace attribution. */
export interface DelegateChain {
  budget: BudgetTracker;
  agent: string;
  worker: string;
  role: TeamRole;
  parentAgent: string;
  delegateCallId?: string;
  /** Marks a delegated child: its own budget, soft/hard cap, and steering. */
  child?: true;
  /** Leader directives for this child, drained at its turn boundaries. */
  steer?: SteerChannel;
}

export interface DelegateToolOptions {
  team: TeamSpec;
  /** The leader's options; the child inherits sandbox, repos, and runtime knobs. */
  parent: EngineOptions;
  /** The leader's budget: children are bounded by what it has left and charged back. */
  budget: BudgetTracker;
  /** What the leader has left, read live when a delegation starts. */
  remaining: () => BudgetRemaining;
  leaderName: string;
  emit: EventSink;
  signal: AbortSignal;
  /** The engine's single-run loop; passed in to keep this module free of a cycle. */
  runChild: (input: RunInput, opts: EngineOptions, chain: DelegateChain) => Promise<AgentResult>;
}

/** The tools a team installs on the leader, plus the live worker registry. */
export interface TeamTools {
  delegate: Tool;
  steer: Tool;
  /** Workers currently running, keyed by worker instance (a host seam for tests). */
  running: Map<string, SteerChannel>;
}

/** A counting semaphore: at most `limit` holders at once, FIFO. */
function semaphore(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Read the `budget` parameter: a loose object, only positive finite numbers. */
function readChildBudget(value: unknown): ChildBudget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const positive = (key: string): number | undefined => {
    const raw = row[key];
    if (raw === undefined || raw === null || raw === "") return undefined;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const steps = positive("steps");
  const wallClockMs = positive("wallClockMs");
  const usd = positive("usd");
  return {
    ...(steps !== undefined ? { steps: Math.floor(steps) } : {}),
    ...(wallClockMs !== undefined ? { wallClockMs: Math.floor(wallClockMs) } : {}),
    ...(usd !== undefined ? { usd } : {}),
  };
}

function rosterLines(team: TeamSpec): string {
  return Object.entries(team.members)
    .map(([name, member]) => {
      const access = member.role === "evaluator" || member.readOnly ? "read-only" : "writes";
      return `- ${name} (${member.role}, ${access})${member.description ? `: ${member.description}` : ""}`;
    })
    .join("\n");
}

export function createTeamTools(options: DelegateToolOptions): TeamTools {
  const { team, parent, budget, remaining, leaderName, emit, signal, runChild } = options;
  const limit = semaphore(Math.max(1, team.maxParallel ?? 4));
  /** Workers that have run in this leader run, and the member they belong to. */
  const known = new Map<string, string>();
  /** Workers running right now; `steer_worker` and the host both push here. */
  const running = new Map<string, SteerChannel>();

  const delegate = defineTool(
    {
      name: "delegate",
      description: [
        "Delegate one bounded task to a worker on your crew. The worker runs in its own context in the same sandbox and returns only its result.",
        "It has its own budget: if you give none it gets at most half of what you have left, capped, and you are told when it ran out or stopped early — a worker's spend never comes out of your step allowance.",
        "Delegate to several different workers in one turn and they run in parallel; calls to the same worker run in order.",
        team.sessions
          ? "A worker remembers its earlier tasks: send fixes and follow-ups to the worker that did the work (same `worker`), or pass fresh: true to start it over."
          : "",
        "Evaluators are read-only. Only you may finish or publish.",
        `Roster:\n${rosterLines(team)}`,
      ]
        .filter(Boolean)
        .join(" "),
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Exact roster name (the role)." },
          worker: {
            type: "string",
            description:
              'Which worker does it, e.g. "frontend-1". Defaults to the roster name. The same worker keeps its memory; a new name is a new worker of that role.',
          },
          task: { type: "string", description: "One bounded task: the objective, the output you expect, and what not to touch." },
          context: { type: "string", description: "Optional compact context; never the full parent transcript." },
          feedback: { type: "string", description: "Optional review findings or repair notes for a follow-up." },
          base: { type: "string", description: "Optional branch or worker to start this worker's workspace from, so it continues that work." },
          budget: {
            type: "object",
            description:
              `Optional budget for this worker — any subset of steps/wallClockMs/usd. Omitted fields default to no more than half of what you have left, capped at ${DEFAULT_CHILD_BUDGET_CAP.steps} steps / ${Math.round(DEFAULT_CHILD_BUDGET_CAP.wallClockMs / 60_000)} min / $${DEFAULT_CHILD_BUDGET_CAP.usd}.`,
            properties: {
              steps: { type: "number", description: "Turn ceiling for this worker." },
              wallClockMs: { type: "number", description: "Wall-clock ceiling in milliseconds." },
              usd: { type: "number", description: "Dollar ceiling for this worker." },
            },
            additionalProperties: false,
          },
          ...(team.admit
            ? { item: { type: "string", description: "The work item this delegation serves (its id in the task plan)." } }
            : {}),
          fresh: { type: "boolean", description: "Forget this worker's earlier tasks and start over." },
        },
        required: ["agent", "task"],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const name = text(input.agent);
      const member = team.members[name];
      if (!member)
        return {
          ok: false,
          content: `unknown team member "${name}" — available: ${Object.keys(team.members).join(", ")}`,
          meta: { agent: name },
        };
      const worker = text(input.worker) || name;
      if (!WORKER_NAME.test(worker))
        return { ok: false, content: `worker "${worker}" must be lowercase letters, digits and dashes, starting with a letter (max 40)` };
      const owner = known.get(worker);
      if (owner && owner !== name)
        return { ok: false, content: `worker "${worker}" is a ${owner}; pick another name for a ${name}` };
      const task = text(input.task);
      if (!task) return { ok: false, content: "task is required" };

      const readOnly = member.role === "evaluator" || member.readOnly === true;
      const item = text(input.item);
      const base = text(input.base);
      if (team.admit) {
        const admitted = await team.admit({
          worker,
          member: name,
          role: member.role,
          readOnly,
          task,
          ...(item ? { item } : {}),
          ...(base ? { base } : {}),
        });
        if (!admitted.ok)
          return { ok: false, content: admitted.reason, meta: { agent: name, worker, role: member.role, refused: true, ...(item ? { item } : {}) } };
      }

      return limit(async () => {
        const fresh = input.fresh === true;
        const sessionId = team.sessions?.id(worker);
        if (team.sessions && sessionId && fresh) await team.sessions.store.save(sessionId, { messages: [] });
        const prior = team.sessions && sessionId && !fresh ? await team.sessions.store.load(sessionId) : undefined;
        const resumed = !!prior && prior.messages.length > 0;
        const place = await team.workspace?.({
          worker,
          member: name,
          role: member.role,
          readOnly,
          resumed,
          ...(base ? { base } : {}),
          ...(item ? { item } : {}),
        });
        known.set(worker, name);

        const tools = readOnly
          ? member.agent.tools.filter((tool) => tool.readOnly === true || tool.definition.name === "run_tests")
          : member.agent.tools;
        // A read-only member loses its mutating tools on purpose; a strategy
        // that lists them as required (the coding strategy needs bash and
        // edit_file) must not refuse to start because of it.
        const kept = new Set(tools.map((tool) => tool.definition.name));
        const strategy = readOnly && member.agent.strategy.requiredTools
          ? {
              ...member.agent.strategy,
              requiredTools: member.agent.strategy.requiredTools.filter(
                (name) => kept.has(name) || !member.agent.tools.some((tool) => tool.definition.name === name),
              ),
            }
          : member.agent.strategy;
        // The child's OWN budget. `delegate` wins over the member limit; a
        // missing dimension derives from the leader's remaining allowance
        // (`deriveChildBudget`). Its spend rolls back into the leader below.
        const requested = readChildBudget(input.budget);
        const memberBudget: ChildBudget = {
          ...(member.maxSteps !== undefined ? { steps: member.maxSteps } : {}),
          ...(member.maxWallClockMs !== undefined ? { wallClockMs: member.maxWallClockMs } : {}),
          ...(member.maxUsd !== undefined ? { usd: member.maxUsd } : {}),
        };
        const childLimits = deriveChildBudget(
          {
            steps: requested.steps ?? memberBudget.steps,
            wallClockMs: requested.wallClockMs ?? memberBudget.wallClockMs,
            usd: requested.usd ?? memberBudget.usd,
          },
          remaining(),
        );
        const childBudget = new BudgetTracker({
          maxSteps: childLimits.steps,
          maxTokens: member.maxTokens ?? budget.limits.maxTokens,
          maxUsd: childLimits.usd,
          maxWallClockMs: childLimits.wallClockMs,
        });
        const contextText = text(input.context);
        const feedback = text(input.feedback);
        const childInput: RunInput = {
          messages: [
            {
              role: "user",
              content: [
                task,
                contextText ? `Context:\n${contextText}` : "",
                feedback ? `Feedback from prior review:\n${feedback}` : "",
                place?.context ? `Where you work:\n${place.context}` : "",
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
        };
        const repos = place?.repos ?? parent.repos;
        const sandbox = place?.sandbox ?? parent.sandbox;
        const childOpts: EngineOptions = {
          llm: member.llm ?? parent.llm,
          agent: { ...member.agent, tools, strategy },
          ...(sandbox ? { sandbox } : {}),
          ...(repos ? { repos } : {}),
          ...(parent.backgroundAfterSecs !== undefined ? { backgroundAfterSecs: parent.backgroundAfterSecs } : {}),
          ...(parent.operations ? { operations: parent.operations } : {}),
          ...(parent.onProgress ? { onProgress: parent.onProgress } : {}),
          ...(team.sessions && sessionId ? { thread: { store: team.sessions.store, id: sessionId } } : {}),
          intrinsics: { finish: false, task: false },
          verifier: false,
          // Checkpoints are the leader's: a worker's hand-back never commits the tree.
          snapshot: false,
          signal,
          onEvent: emit,
        };
        const channel = createSteerChannel();
        running.set(worker, channel);
        try {
          const result = await runChild(childInput, childOpts, {
            budget: childBudget,
            agent: name,
            worker,
            role: member.role,
            parentAgent: leaderName,
            child: true,
            steer: channel,
            ...(ctx.callId ? { delegateCallId: ctx.callId } : {}),
          });
          budget.record(result.usage);
          // A child that ran out of its own budget still returns what it had.
          // That is a partial hand-back, not a failure of the leader's run.
          const partial = result.reason === "budget_exhausted";
          return {
            ok: result.ok,
            content: partial
              ? `Worker ${worker} ran out of its budget before finishing. What it had:\n${result.summary?.trim() || result.error?.trim() || "(nothing produced)"}`
              : result.summary?.trim() || result.error?.trim() || `(${result.reason})`,
            meta: {
              agent: name,
              worker,
              role: member.role,
              resumed,
              ...(item ? { item } : {}),
              status: result.reason,
              steps: result.steps,
              usage: { ...result.usage },
              ...(partial ? { partial: true } : {}),
              ...(result.phase ? { phase: result.phase } : {}),
              ...(result.verified !== undefined ? { verified: result.verified } : {}),
            },
          };
        } finally {
          channel.close();
          running.delete(worker);
        }
      });
    },
    {
      verb: (input) => `Delegating to ${text(input.worker) || text(input.agent)}`,
      resource: (input) => `delegate:${text(input.worker) || text(input.agent)}`,
    },
  );

  const steer = defineTool(
    {
      name: "steer_worker",
      description: [
        "Send a short directive to a worker that is running RIGHT NOW; it arrives at the worker's next turn, labelled as coming from you.",
        "Use it to keep a long delegation on track or tell it to wrap up. It is guidance only — it cannot add evidence or a tool result.",
        `Bounded: ${STEER_MAX_PER_CHILD} directives per worker, ${STEER_MAX_CHARS} characters each.`,
        "A worker that is not currently running cannot be steered; delegate again instead.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          worker: { type: "string", description: 'Exact worker instance name, e.g. "researcher-2".' },
          text: { type: "string", description: "Short, specific directive." },
        },
        required: ["worker", "text"],
        additionalProperties: false,
      },
    },
    async (input) => {
      const worker = text(input.worker);
      const directive = normalizeDirective(text(input.text));
      if (!directive) return { ok: false, content: "text is required" };
      const channel = running.get(worker);
      if (!channel)
        return { ok: false, content: `no worker "${worker}" is running right now — steer only reaches a delegation in flight` };
      if (!channel.push(directive))
        return { ok: false, content: `worker "${worker}" has already taken its ${channel.limit} directives this run` };
      return { ok: true, content: `Directive queued for ${worker}; it will arrive at the worker's next turn.` };
    },
    { verb: (input) => `Steering ${text(input.worker)}` },
  );

  return { delegate, steer, running };
}
