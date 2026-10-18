# Anchor — `@anchor/core`

A small agent runtime: model → tools → observations → model. The agent chooses
the approach; the runtime bounds execution and preserves the record. A normal
final response ends the turn. It is not a verification certificate or permission
to publish changes.

## Quick start

```ts
import { runAgent, createLLMClient } from "@anchor/core";

const llm = createLLMClient({ baseUrl, apiKey, model });
const result = await runAgent({ task: "Explain this idea" }, { llm });
console.log(result.summary);
```

Only the LLM is required. Tools, a sandbox, durable memory, event subscribers,
and custom agent behavior are optional.

```ts
import { codingAgent, runAgent } from "@anchor/core";
import { heyo } from "@anchor/core/sandbox/heyo";

const provider = heyo({
  token,
  server,
  namespace,
  image: "heyo/bun:latest",
  sizeClass: "small",
  diskSizeGb: 4,
});
const sandbox = provider.create({ repoUrl: "https://github.com/you/repo.git" });
try {
  await sandbox.start();
  const result = await runAgent(
    { task: "Improve the README without adding test infrastructure" },
    {
      llm,
      sandbox,
      agent: codingAgent,
      onEvent: (event) => console.log(event),
    },
  );
} finally {
  await sandbox.destroy();
}
```

`@anchor/core/sandbox/local` is an explicit development/test backend, **not
isolation**. Real untrusted repository work belongs in the Heyo microVM
backend. A provider's SDK (e.g. `@heyocomputer/hws` for Heyo) is loaded only
through its subpath — the root entry stays SDK-free. The package does not read
environment variables or depend on the product database/queues.

## One loop, meaningful agent-controlled phases

The coding profile defines an engineering approach:

| Phase        | Goal                                                                        |
| ------------ | --------------------------------------------------------------------------- |
| `understand` | Establish the current request, scope, and relevant facts.                   |
| `plan`       | Decide the change before touching code; name what is deliberately left out. |
| `act`        | Carry out the requested work with the smallest sound intervention.          |
| `validate`   | Gather evidence appropriate to the change and its risks.                    |
| `respond`    | Deliver findings or an outcome, with evidence and limitations.              |

These are guidance and observable progress, not prerequisites. The optional
`set_phase({ phase, reason })` tool records a change of approach. The agent can
skip phases, revisit an earlier one, or answer from any phase. There are no
transition checks, test gates, forced-finish retries, or alternate workflow loop.
Reviewing means inspecting and reporting; addressing review feedback can mean a
focused correction. Neither inherently requires manufacturing a failing test.

The runtime executes only declared tools, validates their argument shape, pairs
every call with its result, and persists completed batches. Failed tools are
observations the agent can interpret; they do not force another task phase.
Repeated identical calls and resource exhaustion stop execution rather than
forcing the model to invent ways around an internal gate.

## Composed prompts and product specialization

The coding prompt is assembled from named components under
`src/agents/coding/prompts/`: character/tone, judgment, operating rules,
verification philosophy, approach phases, and workspace/thread context.

```ts
import { codingAgent, buildCodingPrompt } from "@anchor/core";

const agent = {
  ...codingAgent,
  name: "my-product",
  strategy: {
    ...codingAgent.strategy,
    systemPrompt: ({ context, summary }) =>
      buildCodingPrompt({
        character: "You are our engineering colleague.",
        tone: "Use concise technical notes.",
        context,
        summary,
        additionalSections: [
          { title: "Product capabilities", body: productRules },
        ],
      }),
  },
};
```

Sailor uses this composition: it is the coding agent configured with Sailor's
identity, workspace context, and repository-scoped GitHub tools. It does not
define another loop, another set of phases, or another engineering personality.

Any consumer may instead implement `AgentStrategy`: `name`, phase definitions,
`systemPrompt`, optional `requiredTools`, `requiresSandbox`, and `prepareContext`.
Required capabilities are checked at startup. Everything else is model-led.

## Completion versus side effects

`AgentResult.ok` describes the runtime outcome; `completion` distinguishes a
normal `response` from an optional `declared` handoff. `evidence` contains
observed tool outcomes. Do not interpret a completed response as proof that all
tests passed or automatically push code/post comments from it.

`finish({summary, success, disposition, watch, resumeAt})` remains an optional
structured handoff. It is never required to end a response and has no finish
gate. `watch` is consumer-defined follow-up intent. Phase metadata can support
`pauseAfterPhase` for a caller-controlled pause without enforcing a reasoning
workflow. `intrinsics: { finish: false, phase: false }` hides either optional tool.

Sailor makes publication an explicit `publish_changes` tool, checks repository
selection again at that boundary, and reports actual test evidence. New PRs with
no passing test evidence are drafts. An optional publication policy can withhold
publication, but cannot prevent the assistant from reporting the blocker and
ending its turn. Posting a GitHub reply likewise requires `reply_on_github`.

## Durable conversation and compaction

```ts
import { MemoryThreadStore, runAgent } from "@anchor/core";
const thread = { store: new MemoryThreadStore(), id: "thread-1" };
await runAgent({ task: "Inspect this" }, { llm, thread });
await runAgent({ task: "Now review only; do not edit" }, { llm, thread });
```

`ThreadStore` supplies `load(id)` and `save(id, {summary?, messages, phase?})`.
The actual current request is appended as the latest user message and preserved
in history. Internal messages marked `origin: "engine"` are not promoted into
durable user instructions; ordinary text is never discarded by guessing its
prefix. Product-specific repair of old malformed memory is a separate,
explicit operation. The trace journal is immutable.

Compaction summarizes factual earlier observations and retains a recent,
protocol-safe tail. The current request survives compaction. Usage is counted
against the budget before another inference. Generic defaults are 80k estimated
tokens with a 30k tail; products derive their own from the model's real context
window (`compactionForContextWindow`) — Sailor folds at ~55% of the window,
clamped to the 200–300k working range — so long investigations keep their
accumulated findings. The `compacted` event records what happened —
the folded-transcript preview, the summary it produced, counts, and usage — so
the trace shows both sides of the fold. Disable with `compaction: false`.

## Tools, streaming, and activity labels

Built-in tools: `bash`, `read_file`, `edit_file`, `search`, `run_tests`.
`run_tests` uses an explicit command, a supplied `testCommand`, or repository
detection; absence of a suite is reported, not repaired by inventing one.

`defineTool(definition, run, { verb })` accepts a static or input-dependent
activity label. Tool events carry `callId` and `verb`, such as “Reading repository
file README.md” or “Reviewing the repository code diff”. Labels are developer
metadata, not extra model-generated arguments. Custom labels take precedence.

`llm_text_delta` and provider-returned `llm_reasoning_delta` are separate.
Completed calls carry full text, optional provider reasoning, and optional
`usage.reasoningTokens` (already included in completion tokens). The package
cannot fabricate reasoning that the provider withholds.

## Sandbox providers

A provider is an object, not an options union: `heyo({…})` (microVMs) and
`local()` (dev only) ship behind their subpaths; a new backend implements the
`SandboxProvider` contract — `create(spec)`, `adopt(handle, spec)`,
`release(handle)`, `probe()` — plus capability flags (`fork`, `retain`,
`remoteCheckpoint`, `egressControl`) so products degrade instead of guessing.
`provider.name` travels verbatim on handles, so a new backend can never be
misclassified as an older one. The lifecycle helpers (`openSandbox` /
`releaseSandbox`) adopt a retained handle, fall back to a fresh sandbox, and
retry a fallback ref — provider-agnostic. A conformance suite (pass it → the
adapter is done) ships under `@anchor/core/testing`.

## Sandbox execution and safeguards

| Protection               | Control                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| Resource budgets         | `budgets: {maxSteps, maxTokens, maxUsd}`                         |
| Repeated identical calls | `guardrails.repeatedToolCallLimit` (default 3; `false` disables) |
| Cancellation             | `AbortSignal`, checked before inference and between tools        |
| Context bounds           | `compaction: {maxEstimatedTokens, keepRecentTokens}`             |
| Command deadlines        | Guest process-group/coreutils timeout; per-call `timeout_secs`   |
| Output bounds            | Tool truncation defaults: 300 lines / 20k characters             |
| Persistence              | Per-batch conversation saves and changed-work checkpoints        |
| Trace secrets            | Redaction at the persistence boundary                            |

Heyo commands use a guest-side job and short control-plane observations rather
than holding one HTTP exec open for the full command. The guest deadline remains
in force. Only observation reads are retried; ambiguous launches are not replayed.
A transport failure has `exitCode: -1`, `timedOut: false`, and
`failure: {kind: "transport", completion: "unknown", jobId, message}`. It does
not prove the process was killed. Another command is withheld while an earlier
job remains unconfirmed. The command's stdout, stderr, combined output, and
completion receipt are captured separately.

`Sandbox.hasChangesFrom(ref)` compares content trees, not commit counts; empty
checkpoints must not produce a self-push feedback loop. Changed work can be
checkpointed at turn/pause boundaries without mandatory agent phases.

## Tests

```sh
npm test -w packages/core -- --maxWorkers=2
```

Unit tests use scripted models and local sandboxes. They verify runtime behavior,
not that a real model will always exercise good judgment. Behavioral evaluations
with real models are a separate, explicitly authorized step.
