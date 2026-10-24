/**
 * The leader's `delegate` tool. One call hands one bounded task to one worker
 * (an instance of a roster member) and returns only its result.
 *
 * Parallelism comes from dispatch, not from here: the tool declares
 * `resource: delegate:<worker>`, so one leader turn that delegates to several
 * different workers runs them concurrently, while two calls to the same worker
 * run in order. `maxParallel` bounds how many are in flight at once.
 */
import { BudgetTracker } from "../engine/budgets.js";
import type { EngineOptions, RunInput, AgentResult } from "../engine/types.js";
import type { EventSink } from "../engine/events.js";
import { defineTool, type Tool } from "../tools/types.js";
import { WORKER_NAME, type TeamRole, type TeamSpec } from "./types.js";

/** What the child run is told about who it is, for trace attribution. */
export interface DelegateChain {
  budget: BudgetTracker;
  agent: string;
  worker: string;
  role: TeamRole;
  parentAgent: string;
  delegateCallId?: string;
}

export interface DelegateToolOptions {
  team: TeamSpec;
  /** The leader's options; the child inherits sandbox, repos, and runtime knobs. */
  parent: EngineOptions;
  /** The leader's budget: children are bounded by what it has left and charged back. */
  budget: BudgetTracker;
  leaderName: string;
  emit: EventSink;
  signal: AbortSignal;
  /** The engine's single-run loop; passed in to keep this module free of a cycle. */
  runChild: (input: RunInput, opts: EngineOptions, chain: DelegateChain) => Promise<AgentResult>;
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

function rosterLines(team: TeamSpec): string {
  return Object.entries(team.members)
    .map(([name, member]) => {
      const access = member.role === "evaluator" || member.readOnly ? "read-only" : "writes";
      return `- ${name} (${member.role}, ${access})${member.description ? `: ${member.description}` : ""}`;
    })
    .join("\n");
}

export function createDelegateTool(options: DelegateToolOptions): Tool {
  const { team, parent, budget, leaderName, emit, signal, runChild } = options;
  const limit = semaphore(Math.max(1, team.maxParallel ?? 4));
  /** Workers that have run in this leader run, and the member they belong to. */
  const known = new Map<string, string>();

  return defineTool(
    {
      name: "delegate",
      description: [
        "Delegate one bounded task to a worker on your crew. The worker runs in its own context in the same sandbox and returns only its result.",
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

      return limit(async () => {
        const readOnly = member.role === "evaluator" || member.readOnly === true;
        const fresh = input.fresh === true;
        const sessionId = team.sessions?.id(worker);
        if (team.sessions && sessionId && fresh) await team.sessions.store.save(sessionId, { messages: [] });
        const prior = team.sessions && sessionId && !fresh ? await team.sessions.store.load(sessionId) : undefined;
        const resumed = !!prior && prior.messages.length > 0;
        const base = text(input.base);
        const place = await team.workspace?.({
          worker,
          member: name,
          role: member.role,
          readOnly,
          resumed,
          ...(base ? { base } : {}),
        });
        known.set(worker, name);

        const tools = readOnly
          ? member.agent.tools.filter((tool) => tool.readOnly === true || tool.definition.name === "run_tests")
          : member.agent.tools;
        const limits = budget.limits;
        const childBudget = new BudgetTracker({
          maxSteps: member.maxSteps ?? limits.maxSteps,
          maxTokens: member.maxTokens ?? limits.maxTokens,
          maxUsd: Math.min(member.maxUsd ?? limits.maxUsd, Math.max(0, limits.maxUsd - budget.costUsd)),
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
        const childOpts: EngineOptions = {
          llm: member.llm ?? parent.llm,
          agent: { ...member.agent, tools },
          ...(parent.sandbox ? { sandbox: parent.sandbox } : {}),
          ...(repos ? { repos } : {}),
          ...(parent.backgroundAfterSecs !== undefined ? { backgroundAfterSecs: parent.backgroundAfterSecs } : {}),
          ...(parent.operations ? { operations: parent.operations } : {}),
          ...(team.sessions && sessionId ? { thread: { store: team.sessions.store, id: sessionId } } : {}),
          intrinsics: { finish: false, task: false },
          verifier: false,
          signal,
          onEvent: emit,
        };
        const result = await runChild(childInput, childOpts, {
          budget: childBudget,
          agent: name,
          worker,
          role: member.role,
          parentAgent: leaderName,
          ...(ctx.callId ? { delegateCallId: ctx.callId } : {}),
        });
        budget.record(result.usage);
        return {
          ok: result.ok,
          content: result.summary?.trim() || result.error?.trim() || `(${result.reason})`,
          meta: {
            agent: name,
            worker,
            role: member.role,
            resumed,
            status: result.reason,
            steps: result.steps,
            usage: { ...result.usage },
            ...(result.phase ? { phase: result.phase } : {}),
            ...(result.verified !== undefined ? { verified: result.verified } : {}),
          },
        };
      });
    },
    {
      verb: (input) => `Delegating to ${text(input.worker) || text(input.agent)}`,
      resource: (input) => `delegate:${text(input.worker) || text(input.agent)}`,
    },
  );
}
