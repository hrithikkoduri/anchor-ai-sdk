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
  { messages: [{ role: "user", content: "Explain exponential backoff in plain English" }] },
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

## Task contracts and the judge

One agent handles every turn. There is no chat/coding split and no text-based
intent routing. Enable verification and the agent can create a contract itself
when the request is real work:

```ts
const result = await runAgent(
  { messages: [{ role: "user", content: "Investigate where auth is refreshed" }] },
  {
    llm,
    sandbox,
    thread: { store, id: threadId },
    verifier: true,
  },
);
```

The `create_task` intrinsic is available when `verifier` is enabled and no
contract is active. The agent supplies a goal and 1–30 requirements, each owned
by one of the strategy's phases. The engine derives the authoritative request
text from the user messages; the agent cannot supply or rewrite the standard it
is judged against. A turn without `create_task` is an ordinary conversation with
the same tools and no ledger or completion gate.

Ledger operations are one tool each: `add_requirement` adds a commitment,
`set_requirement_status` changes its status, `link_evidence` attaches a tool
result with a required claim, and `verify_requirement` links and marks it
verified in one call. The single `update_ledger` tool remains as a deprecated
shim. Phase transitions verify the outgoing
phase; a rejection names each unmet requirement and its probability. After the
configured rejection limit the transition is forced, but the requirement stays
open and still blocks `finish`.

The judge is a seam, not an LLM call hidden inside the engine:

```ts
import { llmJudge } from "anchor-ai-sdk";

verifier: {
  create: "agent",                 // or "start" to compile before the first call
  judge: llmJudge(cheapLlm),      // prose judge; per-requirement verdicts
  gates: ["phase", "finish"],
  maxCallsPerTask: 8,
  maxRejectionsPerPhase: 3,
  onError: "allow",
}
```

`llmJudge` is the existing prose verifier adapted to the `Judge` seam. It asks
for per-requirement `cleared | insufficient | unproven` verdicts. A prose-only
final response is gated like `finish`. `finish({
success: false })` ends honestly with `ok: false` and records open requirements
as failures instead of looping into `stalled`.

Compile/verifier usage counts against the run budget. `compileLedger` remains
exported; `create: "start"` is its only path into a run.

## Peer-repository workspaces

A sandbox workspace can contain several peer repositories. The workspace root
is a container, not a git repository:

```text
/workspace
  api/    (repo A, own .git)
  web/    (repo B, own .git)
  infra/  (repo C, own .git)
```

Declare them with `repos`:

```ts
const result = await runAgent(
  { messages: [{ role: "user", content: "Fix the API and its web test" }] },
  {
    llm,
    sandbox,
    agent: codingAgent,
    repos: [
      { name: "acme/api", path: "api" },
      { name: "acme/web", path: "web" },
    ],
  },
);
```

Tools target **one repository per call**:

- `bash({ repository: "acme/api", command: "npm test" })`
- `run_tests({ repository: "acme/api" })`
- `edit_file` attributes its path to the longest matching repo prefix.

There is deliberately no list-shaped “run in all repos” tool. Separate calls
keep results small, attributable, and below the truncation/spill boundary.

Read-only calls keep running in parallel. In a turn containing mutations,
different repository keys may run concurrently; calls in the same repository
serialize. Omit `repository` only for a command that intentionally spans
repositories — it runs at the workspace root and serializes globally. Effectful
tools remain serial and ordered.

### Batching known steps: `createBatchTool`

A model that already knows its next steps can send them as one `batch` call —
one model turn instead of one per step:

```ts
import { createBatchTool } from "anchor-ai-sdk";

const tools = [...myWrappedTools];
const batch = createBatchTool({ tools }); // ops run through YOUR tools
```

```jsonc
{ "phases": [
    { "ops": [ { "op": "read", "paths": ["src/a.ts", "src/b.ts"] },
               { "op": "bash", "command": "git diff --stat HEAD~2..HEAD" } ] },
    { "ops": [ { "op": "edit", "path": "src/a.ts", "old": "…", "new": "…" } ] },
    { "ops": [ { "op": "bash", "command": "npx vitest run src/a.test.ts" } ] } ] }
```

- Ops: `read` (`path`/`paths`, `offset`, `limit`), `search` (`pattern`, `path`,
  `glob`, `regex`), `bash` (`command`, `repository`, `timeout_secs`), `edit`
  (`path`, `old`, `new`, `replaceAll`), `write` (`path`, `content`). A flat
  `ops` list is one phase. At most 20 ops (each read path counts).
- A phase of reads/searches runs concurrently; a phase with an edit, write or
  command runs in order. The batch is a serial mutation for the engine, so its
  writes never overlap anything.
- Every op runs through the tool you passed for it (`read_file`, `search`,
  `bash`, `edit_file`), so your guards hold per op; an op whose tool is absent
  is refused on its own line and the rest still run. `edit`/`write` need
  `edit_file`.
- Edits are all-or-nothing per file and written once through `edit_file`; a
  bad `old` leaves the file untouched and names the failing edit.
- A retry of an edit that already applied reports `already applied` (its `old`
  is gone and its `new` is there), as does a `write` whose file already has
  that content; nothing is written and the op is ok. An ambiguous `old`, or
  neither `old` nor `new` present, still fails.
- After a failed write the batch stops; fix and continue from that op. Once
  the batch has written (an edit, a write, or a `bash` not recognised as a
  read or check), a later failure skips the rest (`stopped after #N: …`);
  before any write, a failure leaves the rest running. An explicit
  `stopOnError` (true or false) overrides both.
- Results: one label per op (`#3 edit src/a.ts — ok (1 replacement, +4/−2)`),
  each op capped at 300 lines and the batch at 600, with the full log's path
  (`logDir`, default `<scratch>/batch`) in the result. The whole batch is bounded
  by `maxBatchSecs` (600).
- Reads and searches are cached in the sandbox across turns (`cache.dir`,
  default `<scratch>/batch-cache`, 200 MB LRU): a read is keyed by the file's
  content hash, a search by its scope's file listing, so a changed file is
  always a miss. Commands, edits and writes are never cached.

`run_tests` in a multi-repo workspace requires `repository`; its metadata
includes that repo and a tree hash computed there. LSP servers are rooted per
repo when you pass `repos` to `createLspTools({ repos })`.

With no `repos`, every tool behaves exactly as before: the workspace root is
the repo. Checkpoints remain single-root; per-repo snapshots are supplied by the
consumer through `EngineOptions.snapshot`.

### Optional skills

Skills are consumer-owned instruction bundles. Anchor supplies a compact index
and an on-demand loader; it does not own storage, trust, or content:

```ts
import {
  createSkillTools,
  renderSkillIndex,
  type SkillProvider,
} from "anchor-ai-sdk";

const index = renderSkillIndex(await provider.list());
const skills = createSkillTools({ provider });
```

The consumer injects `index` into its prompt and adds `skills` to the agent.
`load_skill({ name })` returns a bounded body plus resource paths; scripts run
only through the normal `bash` tool. The body is an untrusted tool result, never
a system message. See [docs/skills.md](docs/skills.md).

### Optional agent teams

A leader can delegate to named workers or evaluators:

```ts
const result = await runAgent(
  { messages: [{ role: "user", content: "Fix the retry bug" }] },
  {
    llm,
    sandbox,
    agent: leaderAgent,
    team: {
      members: {
        implementer: { agent: implementerAgent, role: "worker" },
        reviewer: { agent: reviewerAgent, role: "evaluator" },
      },
    },
  },
);
```

Members run in an isolated nested loop in the same sandbox and return only a
result. Evaluators are read-only; workers cannot finish; only the leader can
finish or publish.

Each child has **its own budget** (`{ steps, wallClockMs, usd }` per
delegation, or a member limit) instead of spending the leader's: by default no
more than half of what the leader has left, capped. At 80% of its budget the
child is told to wrap up; at 100% it hands back a partial result and the
leader's run continues. A child's wall-clock budget is enforced at **every tool
boundary**, not only at turn boundaries: a call already in flight is aborted at
the deadline, so one stuck tool cannot outlive the budget.

A leader — or a host watching `onProgress` — can redirect a running worker with
`steer_worker`, the progress `steer(text)` handle, or `nudge(text)` (same
bounded channel, for a supervisor that wants to say "wrap up"). A child that
produces no event for `stallAfterMs` (default 10 minutes) emits one
`progress` event with `stalled: true` and `stalledForMs` — a signal for the
supervisor, never an automatic cancel.

Anchor exports `TeamTaskStore` / `AgentMailbox` contracts and in-memory
adapters; durable task boards and mailboxes stay consumer-owned. See
[docs/agent-teams.md](docs/agent-teams.md).

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
Heyo configures its default image on the provider. With `imageKind: "artifact"`,
`spec.image` can override the artifact per sandbox. `workspacePath` can select
a checkout already in the image. `requiredEnv` is defined in the shared runner below.

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
    { messages: [{ role: "user", content: "Run the tests and report the results" }] },
    { llm, compaction, agent: codingAgent, sandbox },
  );
  console.log(result.summary, result.reason, result.evidence);
} finally {
  await sandbox.destroy();
}
```

Provider boot settings and optional capabilities differ. Per-sandbox
`spec.image` is supported by Docker and E2B (as a template name), and by Heyo
for artifact refs; Local rejects it. Retention needs a cleanup policy; remote
machines and model calls can cost money. Private HTTPS repositories can use
`spec.git.token`, a caller-supplied credential callback.

The Docker adapter also supports `spec.egress: "none"`: it disconnects container
networks after `start()` setup. Other adapters reject that setting. This is not a
claim that all providers offer equivalent isolation.

### Long-lived processes

`exec()` is one-shot. When a consumer needs a REPL, watcher, dev server, or
language server, providers that declare `capabilities.processStream` also expose
`openProcess()`:

```js
const proc = await sandbox.openProcess("node", ["server.js"], {
  cwd: sandbox.workspace,
  timeoutSecs: 3600,
});
await proc.write("input\n");
for await (const chunk of proc.stdout) process.stdout.write(chunk);
await proc.endInput();
await proc.wait();
```

Streams, `wait`, `kill`, deadline/abort handling, and destroy cleanup are
available. Heyo uses a PTY: stderr is merged, EOF is Ctrl-D, and there is no
transport drain signal. See the [process-stream contract](src/sandbox/README.md).

### Preview a guest port

Providers that declare `capabilities.previewPort` implement
`sandbox.exposePort(port)`. E2B is the first provider: it returns a public
`https://` host for the guest port. Anchor does not add preview authentication,
health checks, iframes, or product UI; that policy belongs to the consumer.

### Publish sandbox images

Providers that can publish expose the common `imagePublisher` contract and the
`anchor image publish` command. Docker pushes a container image, E2B builds a
template, and Heyo uploads an artifact through `heyctl`:

```bash
anchor image publish --provider docker --name ghcr.io/acme/agent:v1 \
  --dockerfile Dockerfile --context .
```

Use the returned `ref` as `spec.image`, or merge Heyo's provider config. This is
provider-native publishing, not a shared Anchor registry. Live registry paths
are credential-gated; see
[docs/sandbox-image-publishing.md](docs/sandbox-image-publishing.md).

### Optional LSP tools

The optional `anchor-ai-sdk/lsp` entry point adds read-only diagnostics,
definition, references, document symbols, hover, completion, signature help,
code actions, formatting previews, rename previews, and workspace symbols over
process streams. The default preset is TypeScript/JavaScript; Python ships as a
second preset, and any stdio language server can be configured:

```js
import { createCodingAgent } from "anchor-ai-sdk";
import { createLspTools, pythonLanguageServer } from "anchor-ai-sdk/lsp";

const base = createCodingAgent();
const agent = {
  ...base,
  tools: [...base.tools, ...createLspTools({ servers: [pythonLanguageServer()] })],
};
```

The default `createLspTools()` keeps the four core tools; use
`createLspTools({ features: "all" })` or `lspAllTools` for the full editor
surface. The sandbox image must provide the configured server:
`typescript-language-server` and a compatible `typescript` for the default
preset, or `pyright` for Python. Search and file reads remain the fallback. See
[docs/lsp.md](docs/lsp.md).

**[Configuration examples](https://anchor-sdk.dev/docs.html#machine)** ·
**[Provider contract and image guide](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/src/sandbox/README.md)** ·
**[Optional LSP tools](docs/lsp.md)** ·
**[Changelog](https://anchor-sdk.dev/changelog.html)**

## Make the agent yours

```text
Agent       = name + strategy + tools
Strategy    = system prompt + phases + optional context preparation
Tool        = model-visible JSON Schema + your handler
runAgent    = messages + agent + model + optional sandbox + runtime settings
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
  { messages: [{ role: "user", content: "Can I get a refund after 20 days?" }] },
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

### Headless workflows: `workflowAgent`

For background jobs that never talk to a user — environment setup, migrations
— build a workflow agent. Nobody reads its prose and nobody answers its
questions, so the engine enforces the contract instead of the conversation:

```js
import { bashTool, editFileTool, readFileTool, runAgent, userTurn, workflowAgent } from "anchor-ai-sdk";

const environment = workflowAgent({
  name: "environment",
  brief: "Infer how to install and boot this app. Write the recipe to .sailor/run.sh and prove it boots.",
  tools: [bashTool, readFileTool, editFileTool],
  check: { command: "bash .sailor/run.sh --check", description: "the app boots and answers on its port" },
  output: {
    name: "recipe",
    schema: {
      type: "object",
      properties: { install: { type: "string" }, start: { type: "string" }, port: { type: "integer" } },
      required: ["install", "start", "port"],
      additionalProperties: false,
    },
  },
  budget: { maxTurns: 30 },
});

const result = await runAgent(userTurn("Repository: acme/web"), { llm, sandbox, agent: environment });
if (result.ok) console.log(result.output); // { install, start, port }, already validated
else console.log(result.reason);           // e.g. "budget_exhausted"
```

- `finish` is the only exit, and it is accepted only when the latest `bash` run
  of `check.command` in this run passed (exit 0, no timeout) and no file was
  edited after it. The check must be the command's final step — a `cd dir &&`
  prefix is fine; `|| true`, a pipe, or `echo` does not count. A rejected
  finish, or a prose reply, comes back as a corrective message and the run continues.
- `output` (a JSON schema or a zod schema) is validated inside that gate and
  returned as `result.output`.
- The conversational nudges (silent-tool, verbose-turn, prose checkpoint) are
  off; the repeated-call, empty-turn, and capped-reply corrections stay on.
- Running out of any budget, `maxTurns` included, ends with `ok: false` and
  `reason: "budget_exhausted"`.
- `ask_questions` is refused, and so is `EngineOptions.inbox`: a workflow run is one-shot.

## Configure the runtime, not another loop

| Capability | Your controls |
| --- | --- |
| **Budgets and correction** | Step/token/known-dollar budgets, per-child crew budgets with a wrap-up nudge and a hard cap, repeated-call detection, silent-tool and visible-verbosity nudges, prose checkpoints, and per-call output requests. |
| **Reasoning budget** | Per-run `reasoningEffort` (`minimal`–`max`) or an agent-bundle default, sent in the provider's native shape (`reasoning.effort` on OpenRouter, `reasoning_effort` on OpenAI). |
| **Prompt caching** | Opt-in `promptCache` breakpoints for Anthropic-style providers, with stable-prefix selection and `cachedTokens` accounting. See [docs/prompt-caching.md](docs/prompt-caching.md). |
| **Composition** | `createAnchor` for reusable model/agent/sandbox/thread wiring, exported coding prompt components, and `view_image` for text-only agents. See [docs/composition.md](docs/composition.md). |
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
import { JsonlTrace, userTurn } from "anchor-ai-sdk";
import { randomUUID } from "node:crypto";

const tracePath = "./traces/" + randomUUID() + ".ndjson";

const result = await runAgent(
  { messages: [{ role: "user", content: "Investigate the failing test" }] },
  {
    llm,
    sandbox,
    agent: codingAgent,
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
  },
);
```

Run usage is checked between calls and can overshoot a budget. Output limits are
requested from the provider. Compaction is lossy summarization using estimated
token sizes; persistence and spill require working storage. Trace redaction is
pattern-based, not a guarantee that all secrets are removed; raw `onEvent` events
are not redacted. Use distinct trace files/IDs per run in your application.

**Cancel grace (behaviour change):** a cancelled run now waits at most
`cancelGraceMs` for the call already in flight — default **5 000 ms** — before
it concludes `cancelled`, instead of waiting on the transport indefinitely.
Pass a larger value when a slow transport needs a longer drain.

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
import { defineTool, userTurn } from "anchor-ai-sdk";

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

await runAgent(userTurn("Investigate the failing test"), {
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
checkpoints, retention/adoption, process streams, and declared optional image
publishing capability.

The repository configures local and Docker conformance in CI. Heyo and E2B live
suites are opt-in and credential-gated; having a suite is not certification that
every account, image, or template has passed it. Custom providers can use the
same contract and tests without rewriting the agent engine.

**[Conformance setup](https://anchor-sdk.dev/docs.html#conformance)** ·
**[Test source](https://github.com/hrithikkoduri/anchor-ai-sdk/tree/main/tests)**

## Evaluated, with the limits visible

### Latest complete harness round: v0.1.7

Anchor versus the external arm (`SWE-agent` for SWE, `Terminus-2` for Terminal)
on the same selected task set. Means are reported in parentheses.

| Bench | Model | Anchor | External | Delta |
|---|---|---:|---:|---:|
| SWE Lite | DeepSeek V4.1 Flash | **7/9 (77.8%)** | 0/10 (0%) | +77.8 pp |
| SWE Lite | Qwen3 Coder Next | **4/8 (50.0%)** | 0/10 (0%) | +50.0 pp |
| SWE Pro | DeepSeek V4.1 Flash | **10/10 (100%)** | 6/10 (60%) | +40.0 pp |
| SWE Pro | Qwen3 Coder Next | **5/10 (50%)** | 3/10 (30%) | +20.0 pp |
| Terminal | DeepSeek V4.1 Flash | 7/10 (70%) | **8/10 (80%)** | -10.0 pp |
| Terminal | Qwen3 Coder Next | 1/10 (10%) | **3/10 (30%)** | -20.0 pp |

Anchor’s full-credit denominator excludes failed tasks; external counts all ten.
The arms use different harnesses, task handling, and budgets. These are selected
samples, not a general superiority claim. The canonical v0.1.7 artifact was
measured at `2fbc92b`, while the `v0.1.7` tag points to `08472b1`.

### v0.1.8

There is **no recorded benchmark result for v0.1.8**. The full round was
interrupted before the Anchor and external arms completed, so partial rows are
not published or compared. The next benchmark record will be a complete round,
labeled with its measured source SHA.

### Historical selected sample

The completed **Parasail GLM 5.3 / SWE-bench Lite-10** records remain available:

| | Anchor | mini-swe-agent |
| --- | --- | --- |
| **Resolved** | **9 / 10** | **9 / 10** |
| Remaining task | Sympy patch unresolved | Matplotlib patch extraction failed; empty patch |
| Recorded usage | 11,363,962 tokens; $4.3162 | Not reported; no cost ratio claimed |
| Published limits | 120 steps / 25M tokens | Its own 250-step / $3 loop |

Both records name `zai-org/GLM-5.3` on Parasail, temperature 0, seed 42, and
Docker-backed tasks. This is a selected ten-task sample with different budgets
and an extraction failure, not the full benchmark or a general superiority claim.

**[Benchmark explorer](https://anchor-sdk.dev/benchmarks.html)** ·
**[Anchor artifacts](https://github.com/hrithikkoduri/anchor-ai-sdk/tree/main/evals/benchmarks/swe-bench/results/glm53-parasail)** ·
**[Mini artifacts](https://github.com/hrithikkoduri/anchor-ai-sdk/tree/main/evals/benchmarks/swe-bench/results/glm53-mini)**

## Status and contributing

**Early alpha, 0.x. Source version: 0.8.12; latest published release: v0.8.12.** Pin exact versions and test your
integration. Provider and runtime features are version-specific; the current
source may be ahead of the installed package. Daytona, agent teams, context
reset, MCP, and consumer skill bundles remain roadmap work in the reviewed
source. See the [changelog](https://anchor-sdk.dev/changelog.html) for what
landed in each tag.

Questions, bug reports, and provider contributions are welcome. Keep mechanics in
the SDK and product policy in the consumer; provider changes should include
conformance coverage and an honest capability declaration.

**[Issues](https://github.com/hrithikkoduri/anchor-ai-sdk/issues)** ·
**[Release status](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/docs/release-status.md)** ·
**[Completed tracker](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/TRACKER.md)** ·
**[Roadmap](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/ROADMAP.md)** ·
**[Engineering decisions](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/DECISIONS.md)** ·
**[MIT license](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/LICENSE)**
