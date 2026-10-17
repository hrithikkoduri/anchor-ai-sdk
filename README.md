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

## Build your own strategy

Implement `AgentStrategy`: give it `phases` (with `advanceOn` predicates over
tool results), `systemPrompt`, `enterPhaseMessage`, optionally `requiredTools`
and `prepareContext`. Pair it with whatever tool set you want — the engine
validates the pairing instead of assuming it. A read-only reviewer, a research
agent, or a triage bot are each one strategy file away from the same engine,
budgets, guardrails, and event stream.

## What the engine enforces (all strategies, no opt-in)

- **Budgets**: step / token / dollar caps, checked before every turn.
- **Loop detection**: the same tool + arguments 3× in a row is blocked with an explanation.
- **Protocol discipline**: turns with no tool calls get nudged twice, then the run is marked stalled.
- **Finish honesty** (strategy-provided `validateFinish`): `codingStrategy` rejects
  `finish(success=true)` unless the most recent full-suite run passed — the model
  cannot claim success without evidence; it can always exit honestly with `success=false`.
- **Events**: `run_started`, `phase_started`, `llm_call_*`, `tool_call`, `tool_result`,
  `guardrail`, `run_finished` — one structured stream for traces, CLIs, and dashboards.
