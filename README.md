# Anchor

**Loop-first, sandbox-first agent framework.** An agent engine you can
actually inspect: it composes its prompt, calls any OpenAI-compatible model,
executes tools inside an isolated sandbox, journals every event, folds its own
context, and stops honestly — a final response ends the turn, and nothing
pretends a test passed.

> **0.0.1 — early alpha.** This is a real, working build (engine, tools, LLM
> client, three sandbox adapters, 193 tests), published to claim the name and
> start the version history. The API will move before 1.0 — pin exact
> versions. Repo: [github.com/hrithikkoduri/anchor-ai-sdk](https://github.com/hrithikkoduri/anchor-ai-sdk).
> Docs: [anchor-sdk.dev](https://anchor-sdk.dev) (coming).

## What's in the box

- **The engine** (`runAgent`): budgets, guardrails on by default, compaction
  derived from the model's real context window, trace sinks with one sequence
  number, revival handoffs, and configurable run snapshots.
- **A tool protocol** — `bash`, `read_file`, `edit_file`, `search`,
  `run_tests` — with structured results. Test evidence is tied to the exact
  tree it ran against (`run_tests` records the tree hash); "green" only counts
  if the tree still matches.
- **A provider-agnostic LLM client**: streaming by default, priced and
  windowed from the provider catalog (`llmFromCatalog`).
- **Sandbox providers behind one contract**, accepted by an executable
  conformance suite (exec fidelity, kill deadlines, checkpoints,
  retain/adopt, git identity, pushes).
- **Durable memory**: `ThreadStore` for conversation, git-backed checkpoints
  for the workspace, and a reserved notes file (`.anchor/notes.md`) that
  rides checkpoints — the agent's own durable record across folds and
  restarts.

## Quickstart

```bash
npm install anchor-ai-sdk
```

```ts
import {
  chatAgent,
  createLLMClient,
  llmFromCatalog,
  runAgent,
} from "anchor-ai-sdk";

const { llm } = await llmFromCatalog({
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_KEY,
  model: "z-ai/glm-5.3",
});

const result = await runAgent(
  { task: "Explain what this repository does" },
  { llm, agent: chatAgent },
);
console.log(result.summary);
```

With a sandbox — Docker shown; the `local` backend needs no daemon:

```ts
import { codingAgent, createLLMClient, runAgent } from "anchor-ai-sdk";
import { docker } from "anchor-ai-sdk/sandbox/docker";

const provider = docker();
const sandbox = provider.create({
  repoUrl: "https://github.com/you/your-repo",
  ref: "main",
});
await sandbox.start();
try {
  const result = await runAgent(
    { task: "Run the tests and fix the failing case" },
    {
      llm: createLLMClient({
        /* … */
      }),
      agent: codingAgent,
      sandbox,
    },
  );
  console.log(result.summary);
} finally {
  await sandbox.destroy();
}
```

## Providers

| subpath                        | backend                           | status                                    |
| ------------------------------ | --------------------------------- | ----------------------------------------- |
| `anchor-ai-sdk/sandbox/heyo`   | Heyo Cloud microVMs (Firecracker) | production path; conformance + live tests |
| `anchor-ai-sdk/sandbox/docker` | containers on the local daemon    | conformance-tested                        |
| `anchor-ai-sdk/sandbox/local`  | this host, **no isolation**       | dev / CI only                             |
| —                              | E2B, Daytona                      | planned — not exported yet                |

A backend is "done" when `runSandboxConformance(provider)` from
`anchor-ai-sdk/testing` passes. The suite gates scenarios on declared
capabilities; capabilities are promises, not vibes.

## The philosophy, short

Trust the reasoning; verify the claims. The engine carries _evidence_ instead
of asserting success: a passing test run is a structured event tied to the
exact tree; publication is an explicit tool call gated on that evidence; a
worker death resumes from a checkpoint instead of re-deriving or pretending.
The same discipline is being measured: Anchor vs mini-swe-agent on SWE-bench
Lite, same container, same model, same grader — equal resolution at roughly
one-third the cost. The comparison table ships with the first tagged release.

## Status & links

- Repo / issues: [github.com/hrithikkoduri/anchor-ai-sdk](https://github.com/hrithikkoduri/anchor-ai-sdk)
- Docs: [anchor-sdk.dev](https://anchor-sdk.dev) (coming)
- License: MIT
