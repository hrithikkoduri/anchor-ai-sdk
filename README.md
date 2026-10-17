# @harness/agent

Loop-first, sandbox-first agent framework.

The **engine** runs the agent loop (LLM ↔ tools, budgets, loop detection, events) and knows nothing about any particular domain. An **AgentStrategy** supplies behavior as data: phases, prompts, required tools, and the rules that advance phases. A **Sandbox** is where work happens (Heyo microVMs or a local process); an **LLMClient** is how the model is reached. We ship a default coding agent — `codingStrategy` — built on exactly the same public API anyone else would use.

## Quick start — the built-in coding agent

```ts
import {
  allTools,
  codingStrategy,
  createLLMClient,
  createSandbox,
  runAgent,
} from "@harness/agent";

// 1. Where the work happens. Bring any backend: heyo (default) or local.
const sandbox = createSandbox(
  { repoUrl: "https://github.com/you/repo.git" },
  { heyo: { token, server, namespace, image: "heyo/bun:latest", sizeClass: "small", diskSizeGb: 4 } },
);
await sandbox.start();

// 2. Run the agent.
const result = await runAgent(
  { task: "add() ignores negative numbers: add(-1,-2) returns 0" },
  {
    llm: createLLMClient({ baseUrl, apiKey, model }),
    sandbox,
    tools: allTools,             // see the required-tools table below
    strategy: codingStrategy,
    budgets: { maxSteps: 40, maxUsd: 5 },
    onEvent: (e) => console.log(e.type), // llm_call, tool_call, phase_started, …
  },
);

console.log(result.ok, result.summary, result.usage);
await sandbox.destroy();
```

## Nothing is mandatory except the model

Everything else has a sensible default — no sandbox, no tools, no strategy
boilerplate:

```ts
import { runAgent } from "@harness/agent";

const reply = await runAgent({ task: "Tell me a joke" }, { llm });
// the default chat strategy replies and ends the run on the text-only turn
```

| Option | Default | Notes |
|---|---|---|
| `strategy` | `chatStrategy` | reply-and-end on a text-only turn; `codingStrategy` declares `requiresSandbox` + `requiredTools`, validated at startup |
| `tools` | `[]` | supply `allTools` (or any subset — individual tools are exported) for coding |
| `sandbox` | none | only needed when the strategy or a tool requires it; sandbox-dependent tools fail with a clear message otherwise |
| `compaction` | on (safe thresholds) | `false` disables |
| `budgets`, `onEvent`, `thread` | safe defaults / optional | see below |

For a single model call with no loop at all, skip the engine entirely —
`llm.complete(...)` is the bare transport (the `generateText` analogue); the
engine adds the loop, tools, guardrails, and events on top.

## The coding strategy

`reproduce → fix → verify`. Phases advance on **tool evidence**, not on the model's claims:

| Phase | Advances to next when… | Soft step budget |
|---|---|---|
| reproduce | `run_tests` **ran and failed** (`meta.ran === true && !ok`, any source — the agent may run a new test explicitly) | 12 |
| fix | the repo's **full suite** ran and passed (`meta.defaultCommand === true` — a targeted subset run cannot advance) | 20 |
| verify | the model calls `finish` — and only with a passing full-suite run on record | 8 |

When a phase exceeds its soft budget the engine nudges the model once: "if you
cannot {goal}, call finish(success=false)" — reproduction can be genuinely
impossible, and that ends gracefully instead of burning the global budget.

**Required tools.** The strategy declares `requiredTools`; the engine validates
them against what you supply and refuses to start on a mismatch:

| Tool | Why the strategy needs it |
|---|---|
| `run_tests` | the evidence that gates phase transitions |
| `edit_file` | applying the fix |
| `finish` | terminating the run (the only way to end it) |
| `bash`, `read_file`, `search` | exploration and orientation |

The prompts mention tools by name (workflow guidance for the model); the API's
`tools` array is what actually makes them callable. `codingStrategy.prepareContext()`
writes a repo map (file list + manifest heads) into the system prompt before the
first LLM call — pass `context` on the task to override it.

## Architecture — units of work

```
consumer (apps/harness, or anyone)
   │   runAgent(task, { llm, sandbox, tools, strategy, budgets, onEvent })
   ▼
┌── ENGINE (engine/loop.ts) ────────────────────────────────────────────┐
│  THE LOOP:  budget check → llm.stream() → dispatch tool calls         │
│             → strategy.advanceOn(result, tool)? → repeat              │
│  HOLDS:     conversation, current phase, evidence log, guardrails     │
│  EMITS:     AgentEvent stream (traces, CLIs, dashboards)             │
└────┬────────────────────┬───────────────────────┬─────────────────────┘
     │ calls               │ consults              │ executes via
     ▼                     ▼                       ▼
┌───────────┐      ┌──────────────┐      ┌───────────────────┐
│ LLMClient │      │   STRATEGY   │      │   Tool registry   │
│ (protocol │      │ phases +     │      │ bash, edit_file,  │
│  only)    │      │ advanceOn +  │      │ run_tests, …      │
└───────────┘      │ finish gate  │      └────────┬──────────┘
                   └──────────────┘               │ sandbox.exec()
                                                  ▼
                                         ┌──────────────────┐
                                         │     SANDBOX      │
                                         │  heyo / local    │
                                         └──────────────────┘
```

Smallest → largest: **tool call** (one ToolResult — the atom) → **turn**
(one LLM call + its tool calls; what budgets count) → **phase** (a mode
spanning turns; exits only on its evidence signature) → **run** (one
`runAgent()`; what a product schedules as a job) → **thread** (a product
concept across runs — deliberately not in this package).

The **evidence spine** is strategy territory, not framework: `codingStrategy`
hangs on `run_tests` (reproduce ← failing run, fix ← passing full run,
`finish` gate ← last full run green). The engine knows none of that — it only
asks `advanceOn`/`validateFinish`. A research strategy picks its own spine
with the same contract.

## Cross-run memory (threads)

A run forgets everything when it ends — unless you hand it a `ThreadStore`.
The engine then loads the prior conversation before the first LLM call and
saves the updated one when the run ends (all exit paths):

```ts
import { MemoryThreadStore, runAgent } from "@harness/agent";

const store = new MemoryThreadStore();                 // or your own ThreadStore
const thread = { store, id: "chat-1" };

await runAgent(task1, { ..., thread });                // run 1 works, conversation saved
await runAgent(task2, { ..., thread });                // run 2 REMEMBERS run 1
```

`ThreadStore` is the interface — `load(id) → { summary?, messages, phase? }`,
`save(id, thread)` (overwrite semantics); the `summary` is the running
compacted summary and flows into the strategy's system prompt. The `phase` is
the **resume position** — written while work is in progress or paused, cleared
when a run completes, so a follow-up on the same thread starts its phases
fresh over the same memory. The package ships the in-memory default; durable
stores (Postgres, SQLite) are implemented by the consumer. The framework never
depends on a database — chat agents, research threads, and the issue→PR
product all consume the same seam.
(LangGraph's "checkpointer" is the same concept under a different name.)

**Compaction keeps long threads inside the context window.** When the
conversation estimate exceeds `compaction.maxEstimatedTokens` (default 80k
estimated tokens, chars/4), the engine folds the oldest span into the `summary`
with one LLM call (usage counted in budgets) and keeps a recent verbatim tail;
the system prompt is regenerated from the new summary. The cut is
protocol-safe — it never splits a tool call from its results — and a
`compacted` event reports what happened. Disable with `compaction: false`.

## Build your own strategy

Implement `AgentStrategy`: give it `phases` (with `advanceOn` predicates over
tool results), `systemPrompt`, `enterPhaseMessage`, optionally `requiredTools`
and `prepareContext`. Pair it with whatever tool set you want — the engine
validates the pairing instead of assuming it. A read-only reviewer, a research
agent, or a triage bot are each one strategy file away from the same engine,
budgets, guardrails, and event stream.

## Guardrails — built in, wired, tuned (not opted into)

Opt-in protections get forgotten; the framework's job is that a runaway agent
cannot happen by accident. All of these are on by default, with dials:

| Guard | Protects against | Knob |
|---|---|---|
| Budgets | runaway cost | `budgets: { maxSteps, maxTokens, maxUsd }` |
| Loop detection | an identical tool call repeated forever | `guardrails.repeatedToolCallLimit` (default 3; `false` disables) |
| Text-only stall | a coding turn that forgets to act | `guardrails.emptyTurnNudgeLimit` (default 2; `false` = never stall — budgets stay the backstop) |
| Compaction | context-window overflow | `compaction: { maxEstimatedTokens, keepRecentTokens } \| false` |
| Finish gate | false success claims | `strategy.validateFinish` (codingStrategy: the last full-suite run must have passed) |
| Command timeouts | hung processes | per-call `timeout_secs`; sandbox kill deadlines |
| Output truncation | context flooding | `truncate()` defaults — 300 lines / 20k chars, one policy |
| Redaction | secrets in traces/DB | always on at the persistence boundary |

Chat-shaped strategies replace the stall guard with `finishWhenNoToolCalls`
(a text-only turn IS the reply). Every intervention surfaces as a `guardrail`
event on the stream (`loop_detected`, `budget_exceeded`, `finish_rejected`),
alongside the rest: `run_started`, `phase_started`, `llm_call_*`, `tool_call`,
`tool_result`, `compacted`, `run_finished` — one structured stream for traces,
CLIs, and dashboards.
