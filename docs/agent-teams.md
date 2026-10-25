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

## Budgets and traces

Each member can set:

```ts
maxSteps?: number;
maxTokens?: number;
maxUsd?: number;
```

The child gets its own tracker bounded by those limits and the leader's
remaining USD. Completed child usage is charged back to the leader's budget.

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
