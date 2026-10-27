# Agent teams: leader, workers, evaluators

Anchor supports one-level delegated subagents. The leader is the normal
`EngineOptions.agent`; the roster is opt-in.

**This is not a second engine.** A delegated member runs a nested `runOne` loop
in the same sandbox, with its own context and tools, and returns only a result.
The child transcript stays in the trace and out of the leader's messages.

## Example

```ts
const team = {
  members: {
    implementer: {
      agent: implementerAgent,
      role: "worker",
    },
    researcher: {
      agent: researchAgent,
      role: "worker",
      readOnly: true,
    },
    reviewer: {
      agent: reviewAgent,
      role: "evaluator",
      llm: reviewModel,
    },
  },
};

const result = await runAgent(
  { messages: [{ role: "user", content: "Fix the retry bug" }] },
  {
    llm: leaderModel,
    agent: leaderAgent,
    sandbox,
    team,
  },
);
```

The leader gets a `delegate` tool:

```ts
delegate({
  agent: "implementer",
  task: "Fix the deadline handling and run the tests",
  context: "Only api/ is writable; web/ is context.",
})
```

## Roles

| Role | Permissions | Return |
| --- | --- | --- |
| `worker` | Normal tools, optionally `readOnly` | Summary, status, steps, usage |
| `evaluator` | Always read-only (read/search/LSP plus `run_tests`) | Summary/verdict as text |

Rules:

- Only roster names can be delegated to.
- Evaluators cannot edit, delegate, or `finish`.
- Workers cannot `delegate` or `finish` in the child run.
- Only the leader can finish or publish.
- Delegation is one level: child runs do not receive the roster.
- Delegations to different workers run in parallel; the same worker runs in order.

## Result contract

The leader receives a normal tool result:

```ts
{
  ok: true,
  content: "Changed the deadline and added a regression test.",
  meta: {
    agent: "implementer",
    role: "worker",
    status: "finished",
    steps: 7,
    usage: { promptTokens: 12000, completionTokens: 900, totalTokens: 12900 },
  },
}
```

No child messages or transcript are returned. Full child events are in the
trace.

## Budgets, wrap-up, steering, and progress

**Motivation.** Five crew workers on two vCPUs: one worker mapped the codebase
in 47 steps / 3 minutes; another, with an open-ended brief, spent 194 steps /
48 minutes / 458 tool calls on the same task. A worker had no budget of its
own, so it could spend the leader's whole allowance.

### Per-child budgets

A child runs its own `BudgetTracker`; its spend rolls up into the leader's
totals for accounting but never spends the leader's step allowance. Pass a
budget on the delegation (any subset of `steps`, `wallClockMs`, `usd`):

```ts
delegate({
  agent: "researcher",
  worker: "researcher-2",
  task: "Map the auth flow and stop at the boundary.",
  budget: { steps: 25, wallClockMs: 5 * 60_000, usd: 0.75 },
});
```

A member may set the same fields as defaults:

```ts
maxSteps?: number;
maxTokens?: number;
maxUsd?: number;
maxWallClockMs?: number;
```

Precedence: the `delegate` budget wins, then the member limit, then the
derived default. **Wall-clock is checked at turn boundaries** (the only safe
cancel point), so one long tool call can overrun it before the loop stops.

### The derived default

If neither is given, `deriveChildBudget` (a pure, exported function) gives a
child **no more than half of the leader's remaining budget, capped**:

```ts
DEFAULT_CHILD_BUDGET_FRACTION = 0.5;
DEFAULT_CHILD_BUDGET_CAP = { steps: 60, wallClockMs: 12 * 60_000, usd: 1.5 };
// value = explicit ?? min(fraction × remaining, cap)
```

The cap bounds otherwise-enormous leader allowances; `steps` never derives
below 1. An explicit budget may exceed the cap.

### Soft cap, hard cap

At **80%** of its budget (`DEFAULT_CHILD_SOFT_CAP`) the child receives one
wrap-up directive in its own stream — a runtime message the model reads, not a
tool and not a user turn:

> Wrap-up directive from your leader: you have N steps left of your budget
> (…). Stop exploring. Answer what you can now, list what is unfinished, and
> hand back — a partial result stated clearly is worth more than a complete one
> you never deliver.

At **100%** the child's loop ends and it hands back what it has. The result is
`reason: "budget_exhausted"`, `meta.partial: true`, and the content carries the
child's last visible answer. **A worker running out never fails the leader's
run.**

### Steering a running worker

A `delegate` call blocks the leader's model turn, so the leader cannot
intervene from inside its own loop. Two seams share one bounded channel:

- `EngineOptions.onProgress` — the host reacts to a child's progress (below).
- `steer_worker` — a tool registered on the leader whenever a team exists.

```ts
steer_worker({ worker: "researcher-2", text: "Stop mapping. Summarize now." });
```

A directive reaches the worker's **next turn** as an ordinary message labelled
`[from the leader] …`. It is **bounded** (`STEER_MAX_PER_CHILD = 5`),
**length-capped** (`STEER_MAX_CHARS = 500`), and can never be a tool result, so
it cannot forge evidence. A worker that is not currently running cannot be
steered.

### Progress the leader can act on

While a child runs, the engine emits a compact `progress` event per child turn
and calls `onProgress`:

```ts
{
  type: "progress",
  worker: "researcher-2",
  steps: 12,
  budgetUsed: 0.48,        // the tightest dimension, 0..1
  lastTool: "read_file",
  filesTouched: ["src/auth.ts"],
}
```

The callback gets the same record plus a `steer(text)` handle, so a supervisor
can watch a delegation and redirect it without waiting for it to end:

```ts
onProgress: (p) => {
  if (p.worker === "researcher-2" && p.budgetUsed > 0.6 && p.lastTool === "read_file") {
    p.steer("You have enough. Write the summary now.");
  }
},
```

Never the child's transcript — one compact record per turn.

### Traces

Child events carry:

```ts
agent: "reviewer";
parentAgent: "leader";
delegateCallId: "call_...";
```

This lets a trace sink render the team tree without a separate event system.

## Review loop

The leader decides the sequence. A typical bounded loop:

```text
worker -> evaluator
   ^          |
   |          | fail / insufficient
   +----------+
          |
         pass
          ↓
       verifier
          ↓
       finish
```

The evaluator is advisory. The existing verifier remains the contract gate.
Keep review rounds bounded in the leader prompt or consumer policy.

## Consumer-owned coordination

Anchor now exports the store contracts and in-memory adapters:

```ts
import {
  MemoryAgentMailbox,
  MemoryTeamTaskStore,
  type AgentMailbox,
  type TeamTaskStore,
} from "anchor-ai-sdk";
```

- `TeamTaskStore` — child work items with atomic `claim`, lease expiry,
  owner, status, repo, result, and evidence.
- `AgentMailbox` — addressed agent messages with `claim`, `ack`, and `release`.
- The human decision queue remains the consumer's `ask_questions` mechanism.

Sailor should implement these interfaces in Postgres. A single Markdown
task-board file is not safe for concurrent writers.

### Task board

```text
queued -> claimed -> in_progress -> done | failed
                    ^
                    +--- lease expires -> reclaimable
```

`claim()` is atomic and succeeds only for a queued task or a task whose lease
expired. `release()` returns a task to the queue only for its current owner.

### Mailbox

Messages are addressed, typed, and scoped:

```ts
await mailbox.send({
  threadId,
  teamTaskId: "t1",
  fromAgent: "reviewer",
  toAgent: "implementer",
  kind: "review",
  body: "The timeout case still fails.",
});
```

Recipients claim pending messages; delivered messages are lease-protected and
reclaimable after expiry. `ack()` marks them answered; `release()` returns them
to pending.

A mailbox is required for true peer-agent teams. It is not needed for
leader-mediated subagents, where `delegate` returns synchronously.

## A crew: instances, memory, parallel work, workspaces

```ts
const team: TeamSpec = {
  members: {
    frontend: { agent: frontendAgent, role: "worker", description: "UI, React, design system" },
    backend: { agent: backendAgent, role: "worker", description: "APIs, data, migrations" },
    reviewer: { agent: reviewAgent, role: "evaluator", description: "rigorous code review" },
  },
  // A worker's conversation persists: follow-ups resume it.
  sessions: { store: threadStore, id: (worker) => `${threadId}:crew:${worker}` },
  // Where a worker works: e.g. one git worktree + branch per writer.
  workspace: async ({ worker, readOnly, base }) =>
    readOnly ? undefined : await worktreeFor(worker, base),
  maxParallel: 4,
};
```

- **Workers.** `delegate({ agent: "frontend", worker: "frontend-2", task })`.
  The member is the role; the worker is the instance. Omit `worker` and the
  roster name is used. A worker name belongs to one member.
- **Memory.** With `sessions`, delegating to the same worker again resumes its
  conversation (`meta.resumed: true`). `fresh: true` starts it over.
- **Parallel.** Delegations to different workers in one leader turn run
  concurrently (bounded by `maxParallel`); the same worker runs in order.
- **Workspaces.** `workspace` gets `{ worker, member, role, readOnly, base,
  resumed }` and returns `{ repos?, context? }`: the repositories as the worker
  sees them and a sentence appended to its task ("Where you work: …"). `base` is
  the leader's hint to continue from another branch or worker.

Tools called inside a delegated run get `ctx.team = { worker, member, role }`,
so a shared tool instance can file work under the worker that called it.

Events from a worker carry `agent` (member), `worker`, `role`, `parentAgent`,
and `delegateCallId`. The live projector keeps a separate text stream per
delegation and forwards those fields; `projectConversation` nests a worker's
transcript on the leader's `delegate` part as `delegation`.

## A worker in its own tree

`team.workspace` may return `sandbox` — usually `scopedSandbox(sandbox, dir)`,
a view rooted at the worker's tree. Commands and file tools then default to that
directory, so `edit_file("src/a.ts")` lands in the worker's worktree, and the
returned `repos` are relative to it. A view never starts or destroys the real
sandbox. Workers never checkpoint: checkpoints are the leader's.

Language servers are per sandbox object: reuse one view per worker tree so a
worker keeps its warm server across delegations, and call
`closeLspSessions(view)` (from `anchor-ai-sdk/lsp`) when you are done with it.
`warmLspSessions(view, { servers, repos, files })` starts a worker's servers and
loads its projects in the background as soon as it is given a task.

## Admission

`team.admit` decides whether a delegation may run, before any workspace or
child run exists. It receives `{ worker, member, role, readOnly, task, item?,
base? }` and returns `{ ok: true }` or `{ ok: false, reason }`; a refusal is the
leader's tool result, its reason verbatim. With `admit` installed the
`delegate` tool also takes `item` — the consumer's work item (a plan item id) —
which is passed to `workspace` and recorded in the result's `meta.item`.

This is where a consumer enforces its plan, approvals and gates, instead of
trusting the leader's prompt to respect them.

## Current limits

- Depth is one; no recursive teams.
- No automatic review loop; the leader chooses when to delegate.
- Members share one sandbox; separate working trees are the consumer's
  `workspace` hook.
- Checkpoints and publication remain leader-owned.
