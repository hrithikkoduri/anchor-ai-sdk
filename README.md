<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/hrithikkoduri/anchor-ai-sdk/d4e34e41ccb6fbb83d4c54824dd3383b5e84adc4/assets/readme-hero-dark.svg" />
    <img src="https://raw.githubusercontent.com/hrithikkoduri/anchor-ai-sdk/d4e34e41ccb6fbb83d4c54824dd3383b5e84adc4/assets/readme-hero.svg" alt="Anchor. Your agent. Your machine. One runtime to wire them together." width="1200" />
  </picture>
</p>

<p align="center">
  <strong>A TypeScript agent harness SDK.</strong><br />
  Define the behavior. Choose the machine. Let the shared runtime handle the turns.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/anchor-ai-sdk"><img src="https://img.shields.io/npm/v/anchor-ai-sdk?style=flat-square&color=c2410c" alt="npm version" /></a>
  <a href="https://github.com/hrithikkoduri/anchor-ai-sdk/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/hrithikkoduri/anchor-ai-sdk/ci.yml?style=flat-square&label=ci&color=111114" alt="CI status" /></a>
  <a href="https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-111114?style=flat-square" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-111114?style=flat-square" alt="Node.js 20 or newer" />
</p>

<p align="center">
  <a href="https://anchor-sdk.dev/docs.html"><strong>Documentation</strong></a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#one-sandbox-interface">Sandboxes</a> ·
  <a href="#make-the-agent-yours">Custom agents</a> ·
  <a href="https://anchor-sdk.dev/benchmarks.html">Benchmarks</a>
</p>

---

Anchor runs the **model → tools → observations → model** loop around your agent.
It combines configurable guardrails, context compaction, continuation primitives,
and structured events with a sandbox layer that can also be used on its own.

**Your app keeps control of the model, prompts, tools, storage, credentials, and
release policy.** There is no requirement to turn an agent into a workflow graph.

| Build around | What Anchor supplies |
| --- | --- |
| **Your agent** | Chat and coding bundles, or your own strategy and toolset. Phases label the approach; they are not permissions. |
| **Your machine** | One `SandboxProvider` / `Sandbox` surface for Heyo Computer, E2B, Docker, and local development. |
| **Longer tasks** | Conversation compaction, thread-store interfaces, working notes, checkpoints, and opt-in revival planning. |
| **Observable execution** | Streaming events, tool-result metadata, NDJSON/custom trace sinks, and replay helpers. |

## Quickstart

```bash
npm install anchor-ai-sdk
```

Save as `agent.mjs`. This is ordinary JavaScript with ES modules; `.js` also works
when your `package.json` contains `"type": "module"`.

```js
import { chatAgent, llmFromCatalog, runAgent } from "anchor-ai-sdk";

const { llm, compaction } = await llmFromCatalog({
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_KEY,
  model: process.env.MODEL ?? "z-ai/glm-5.3",
});

const result = await runAgent(
  { task: "Explain exponential backoff in plain English" },
  { llm, compaction, agent: chatAgent },
);

console.log(result.summary);
```

```bash
export OPENROUTER_KEY="your-key"
node agent.mjs
```

No sandbox is needed for this chat example. Model calls may incur cost.
`llmFromCatalog` uses provider pricing and context-window metadata when available;
pass its returned `compaction` settings to the engine as shown. Catalog lookup is
best-effort; configure overrides and fallbacks for endpoints without this metadata.

## Task verification

For tasks that need evidence before completion, enable the opt-in verifier:

```ts
const result = await runAgent(
  { task: "Investigate where auth is refreshed" },
  {
    llm,
    sandbox,
    thread: { store, id: threadId },
    verifier: true,
  },
);
```

The SDK owns the ledger, intent routing, evidence capture, and phase/finish
checks. The consumer supplies only the normal `ThreadStore` (the ledger is an
optional field on `StoredThread`) and the model. Greetings and other chat turns
create no ledger and make no verifier call. A separate cheap verifier model is
optional:

```ts
verifier: {
  llm: cheapLlm,
  gates: ["phase", "finish"],
  allowWaived: true,
}
```

`finish` is rejected while a required ledger item is open or lacks linked
evidence; the agent loops with the missing-evidence feedback. Compiler and
verifier token usage is counted against the run budget.

## One sandbox interface

**Configure the provider once. Keep the agent-facing machine interface the same.**
The same layer works with the built-in coding tools, custom agents, or direct
`sandbox.exec()` calls without an agent. For long-lived consumers — LSPs, REPLs,
dev servers, watchers — `sandbox.openProcess()` is the optional persistent
stdin/stdout primitive; check `provider.capabilities.processStream` first.

| Provider | Import | Boot configuration |
| --- | --- | --- |
| **Heyo Computer** | `anchor-ai-sdk/sandbox/heyo` | Image artifact/store on the provider; host-built image kinds are also supported. |
| **E2B** | `anchor-ai-sdk/sandbox/e2b` | A prepared template name or ID, **not** an arbitrary Docker image at create time. |
| **Docker** | `anchor-ai-sdk/sandbox/docker` | An explicit container image, Docker CLI, and running daemon. |
| **Local** | `anchor-ai-sdk/sandbox/local` | Host processes and a working directory. **No isolation; trusted dev/CI only.** |

Choose one of the configurations below. Each defines `provider`; the common
runner that follows uses the `llm` and `compaction` from the quickstart.

<details open>
<summary><strong>Heyo Computer: choose an image and machine size</strong></summary>

```bash
npm install @heyocomputer/hws
```

```js
import { heyo } from "anchor-ai-sdk/sandbox/heyo";

const provider = heyo({
  token: requiredEnv("HEYO_TOKEN"),
  server: requiredEnv("HEYO_SERVER"),
  namespace: requiredEnv("HEYO_NAMESPACE"),
  image: requiredEnv("HEYO_IMAGE"),
  imageKind: "artifact",
  imageStore: requiredEnv("HEYO_IMAGE_STORE"),
  sizeClass: "small",
  diskSizeGb: 10,
});
```

Use an artifact/store you can access and a toolchain suitable for the task.
Heyo configures its image on the provider and rejects per-sandbox `image` and
`workspacePath` overrides. `requiredEnv` is defined in the shared runner below.

</details>

<details>
<summary><strong>E2B: choose a prepared template</strong></summary>

```bash
npm install 'e2b@^2.56'
```

```js
import { e2b } from "anchor-ai-sdk/sandbox/e2b";

const provider = e2b({
  apiKey: requiredEnv("E2B_API_KEY"),
  template: requiredEnv("E2B_TEMPLATE"),
  timeoutMs: 60 * 60_000, // sandbox lifetime, not a command timeout
});
```

Build a template with `bash`, `git`, coreutils (including `timeout`), and the
language tools your task needs. `spec.image` can override the template per run;
`workspacePath` points to a Git workspace already prepared inside it. Neither
option turns a Docker image name into an E2B template automatically.

</details>

<details>
<summary><strong>Docker: supply your container image</strong></summary>

```js
import { docker } from "anchor-ai-sdk/sandbox/docker";

const provider = docker({
  image: requiredEnv("ANCHOR_DOCKER_IMAGE"),
});
```

The image must already contain the required tools; Anchor does not infer or
install your repository's dependencies. `spec.image` overrides the default.
Use `workspacePath` only when the image already contains the Git workspace.

</details>

### Pass the machine to an agent

Combine **one** provider configuration above with this runner and the model setup
from the quickstart. Merge imports when composing an existing application.

```js
import { codingAgent } from "anchor-ai-sdk";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this example.`);
  return value;
}

const sandbox = provider.create({
  repoUrl: requiredEnv("REPO_URL"),
  ref: process.env.REPO_REF ?? "main",
});

try {
  await sandbox.start();
  const result = await runAgent(
    { task: "Run the tests and report the results" },
    { llm, compaction, agent: codingAgent, sandbox },
  );
  console.log(result.summary, result.reason, result.evidence);
} finally {
  await sandbox.destroy();
}
```

Provider boot settings and optional capabilities differ. Per-sandbox
`spec.image` is supported by Docker and E2B (as a template name), and by Heyo
for artifact refs; Local rejects it. Providers that can build/publish expose
`imagePublisher`, also available as `anchor image publish`.
Retention needs a cleanup policy; remote machines and model calls can cost money. Private HTTPS repositories
can use `spec.git.token`, a caller-supplied credential callback.

The latest Docker adapter also supports `spec.egress: "none"`: it disconnects
container networks after `start()` setup. Other adapters reject that setting.
This is not a claim that all providers offer equivalent isolation.

Providers that can build images expose the common `imagePublisher` contract and
the `anchor image publish` command, so Docker, E2B, and Heyo each use their own
native registry while the caller keeps one shape. `anchor image publish --help`
shows the flags. Per-provider instructions are in
[docs/sandbox-image-publishing.md](docs/sandbox-image-publishing.md).

**[Configuration examples](https://anchor-sdk.dev/docs.html#machine)** ·
**[Provider contract and image guide](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/src/sandbox/README.md)**

## Make the agent yours

```text
Agent       = name + strategy + tools
Strategy    = system prompt + phases + optional context preparation
Tool        = model-visible JSON Schema + your handler
runAgent    = task + agent + model + optional sandbox + runtime settings
```

Use `chatAgent` or `codingAgent`, compose a bundle, or pass `strategy` and `tools`
separately. A custom agent is not required to be a coding agent or use a machine.

<details>
<summary><strong>Example: a small policy assistant with its own tool</strong></summary>

This fragment uses `llm` and `compaction` from the quickstart. The policy is demo
data; a real service needs your authorization, validation, and output limits.

```js
import { defineTool, requireString } from "anchor-ai-sdk";

const policies = new Map([
  ["refunds", "Refunds are available within 30 days with the original receipt."],
]);

const lookupPolicy = defineTool(
  {
    name: "lookup_policy",
    description: "Look up a policy by topic.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
  },
  async (input) => {
    const policy = policies.get(requireString(input, "topic").trim().toLowerCase());
    return { ok: policy !== undefined, content: policy ?? "No policy found." };
  },
);

const policyAgent = {
  name: "policy-assistant",
  strategy: {
    name: "policy",
    phases: [{ id: "answer", goal: "Answer using the retrieved policy." }],
    requiredTools: ["lookup_policy"],
    systemPrompt: () =>
      "Look up policy before making policy claims. Say when it is unknown.",
  },
  tools: [lookupPolicy],
};

const answer = await runAgent(
  { task: "Can I get a refund after 20 days?" },
  { llm, compaction, agent: policyAgent },
);
console.log(answer.summary);
```

The schema is declared to the model; `defineTool` does not perform full JSON
Schema validation. It catches thrown handler errors as failed tool results.
Validate inputs and enforce permissions in your implementation.

</details>

**[Tools and schemas](https://anchor-sdk.dev/docs.html#tools)** ·
**[Runnable SDK examples](https://github.com/hrithikkoduri/anchor-ai-sdk/tree/main/examples)**

## Configure the runtime, not another loop

| Capability | Your controls |
| --- | --- |
| **Budgets and correction** | Step/token/known-dollar budgets, repeated-call detection, silent-tool and visible-verbosity nudges, prose checkpoints, and per-call output requests. |
| **Reasoning budget** | Per-run `reasoningEffort` (`minimal`–`xhigh`) or an agent-bundle default, sent in the provider's native shape (`reasoning.effort` on OpenRouter, `reasoning_effort` on OpenAI). |
| **Context and memory** | Catalog-derived or explicit compaction, supplied thread stores, agent-authored notes, and best-effort output spill. |
| **Revival and resume** | Opt-in budget warnings, `request_revival`, `planRevival`, and `ThreadBudget`. Your app persists state and decides whether to fund or enqueue another run. |
| **Snapshots and lifecycle** | Git-backed or custom snapshot hooks, optional push, phase-boundary pauses, heartbeats, and cancellation. |
| **Streaming and traces** | Raw `onEvent` updates; sequenced, pattern-redacted `traceSinks`; NDJSON files, custom sinks, live projection, and replay. |
| **Execution evidence** | Tool names/status/metadata plus recorded test-command outcomes and optional post-run Git freshness checks. Your app defines verification and release gates. |
| **External effects** | Declared effects, a write-ahead operation journal, stable operation ids, reconciliation on resume, and a stop on unknown outcomes. |

<details>
<summary><strong>Example: limits, nudges, compaction, and a recorded trace</strong></summary>

Runtime options for a model and started sandbox configured by your host:

```js
import { JsonlTrace } from "anchor-ai-sdk";
import { randomUUID } from "node:crypto";

const tracePath = "./traces/" + randomUUID() + ".ndjson";

const result = await runAgent({ task: "Investigate the failing test" }, {
  llm, sandbox, agent: codingAgent,
  budgets: { maxSteps: 60, maxUsd: 3 },
  compaction: { maxEstimatedTokens: 60_000, keepRecentTokens: 15_000 },
  guardrails: {
    repeatedToolCallLimit: 3,
    toolOnlyNudgeLimit: 8,
    verboseTurnLimit: 8_000,
    proseCheckpoint: true,
  },
  maxOutputTokens: 16_000,
  traceSinks: [new JsonlTrace(tracePath)],
  onEvent(event) {
    if (event.type === "llm_text_delta") process.stdout.write(event.text);
  },
});
```

Run usage is checked between calls and can overshoot a budget. Output limits are
requested from the provider. Compaction is lossy summarization using estimated
token sizes; persistence and spill require working storage. Trace redaction is
pattern-based, not a guarantee that all secrets are removed; raw `onEvent` events
are not redacted. Use distinct trace files/IDs per run in your application.

</details>

**[Compaction](https://anchor-sdk.dev/docs.html#compaction)** ·
**[Course correction](https://anchor-sdk.dev/docs.html#correction)** ·
**[Revival and host-side resume](https://anchor-sdk.dev/docs.html#revival)** ·
**[Streaming and detailed traces](https://anchor-sdk.dev/docs.html#traces)**

> **A completed run is not a correctness certificate.** `run_tests` records a
> command outcome and, when available, a Git hash captured **after** the command.
> `latestEvidenceForTree` can compare it with the current tree, but does not prove
> an immutable tested snapshot, require a full suite, or inspect assertions.

## Recovering external writes

A crash between "the target accepted the write" and "the thread saved the
result" must not become a duplicate write. A tool that changes something outside
the workspace declares an effect; the engine then records the intent before the
call and settles it after:

```js
const createIssue = defineTool({ name: "create_issue", /* ... */ }, async (input, ctx) => {
  const issue = await github.createIssue(input, {
    idempotencyKey: ctx.operationId, // stable across retries
  });
  await ctx.acknowledge?.({ issue: issue.number });
  return { ok: true, content: `Created #${issue.number}` };
}, {
  effect: {
    async reconcile({ operationId }) {
      const found = await github.findByKey(operationId);
      return found
        ? { status: "applied", result: { ok: true, content: found.url } }
        : { status: "unknown" };
    },
  },
});

await runAgent(task, {
  llm, agent, sandbox,
  operations: { store }, // a durable table in production
});
```

On resume, a pending operation is reconciled, never replayed. An unknowable
outcome ends the run with `reason: "recovery_required"` and
`AgentResult.pendingOperations`. `MemoryOperationStore` is for tests; production
needs a durable table with a unique `operation_id`. The target's participation
(an idempotency key or a status lookup) is what turns this into
effectively-once; without it, the harness surfaces the ambiguity instead of
guessing.

## Test the machine contract

`runSandboxConformance(provider)` from `anchor-ai-sdk/testing` exercises the
public sandbox contract: command results, deadlines, environment handling, Git
checkpoints, retention/adoption, and declared optional capabilities.

The repository configures local and Docker conformance in CI. Heyo and E2B live
suites are opt-in and credential-gated; having a suite is not certification that
every account, image, or template has passed it. Custom providers can use the
same contract and tests without rewriting the agent engine.

**[Conformance setup](https://anchor-sdk.dev/docs.html#conformance)** ·
**[Test source](https://github.com/hrithikkoduri/anchor-ai-sdk/tree/main/tests)**

## Evaluated, with the limits visible

The completed **Parasail GLM 5.3 / SWE-bench Lite-10** records show:

| | Anchor | mini-swe-agent |
| --- | --- | --- |
| **Resolved** | **9 / 10** | **9 / 10** |
| Remaining task | Sympy patch unresolved | Matplotlib patch extraction failed; empty patch |
| Recorded usage | 11,363,962 tokens; $4.3162 | Not reported; no cost ratio claimed |
| Published limits | 120 steps / 25M tokens | Its own 250-step / $3 loop |

Both records name `zai-org/GLM-5.3` on Parasail, temperature 0, seed 42, and
Docker-backed tasks. This is a selected ten-task sample with different budgets
and an extraction failure, not the full benchmark or a general superiority
claim. The older 7/10 OpenRouter cost comparison is separate historical context.

**[Benchmark explorer](https://anchor-sdk.dev/benchmarks.html)** ·
**[Anchor artifacts](https://github.com/hrithikkoduri/anchor-ai-sdk/tree/main/evals/benchmarks/swe-bench/results/glm53-parasail)** ·
**[Mini artifacts](https://github.com/hrithikkoduri/anchor-ai-sdk/tree/main/evals/benchmarks/swe-bench/results/glm53-mini)**

## Status and contributing

**Early alpha, 0.x.** Pin exact versions and test your integration. Provider and
runtime features are version-specific; the current source may be ahead of the
installed package. Daytona, agent teams, and consumer skill bundles remain
roadmap work in the reviewed source.

Questions, bug reports, and provider contributions are welcome. Keep mechanics in
the SDK and product policy in the consumer; provider changes should include
conformance coverage and an honest capability declaration.

**[Issues](https://github.com/hrithikkoduri/anchor-ai-sdk/issues)** ·
**[Roadmap](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/ROADMAP.md)** ·
**[Engineering decisions](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/DECISIONS.md)** ·
**[MIT license](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/LICENSE)**
