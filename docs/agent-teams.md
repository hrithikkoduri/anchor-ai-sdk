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
- Delegated runs stay serialized; read-only tools still follow normal dispatch.

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

Anchor deliberately does not add a team task board, agent mailbox, or human
decision queue. Those are consumer-owned stores/UI:

- task board: claimed work, owner, status, repo, lease
- agent mailbox: addressed requests/results/questions
- human decision queue: existing `ask_questions` / `question_requests`

Keep a single Markdown task-board file out of concurrent write paths. Use a
database or per-agent append-only files, then let the leader merge.

## Current limits

- Depth is one; no recursive teams.
- Delegation is serial, not parallel across workers.
- No automatic review loop; the leader chooses when to delegate.
- No child thread/sandbox; members share the leader's sandbox.
- No built-in task board/mailbox/decision queue.
- Checkpoints and publication remain leader-owned.
