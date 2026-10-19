<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/hrithikkoduri/anchor-ai-sdk/main/assets/logo-dark.svg" />
    <img src="https://raw.githubusercontent.com/hrithikkoduri/anchor-ai-sdk/main/assets/logo.svg" alt="Anchor" width="96" />
  </picture>
</p>

<h1 align="center">Anchor</h1>

<p align="center">
  <strong>Loop-first, sandbox-first agent harness SDK.</strong><br />
  Give it a task and a machine — it reasons, runs tools, checks its own work, and keeps the receipts.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/anchor-ai-sdk"><img src="https://img.shields.io/npm/v/anchor-ai-sdk?style=flat-square&color=0f1115" alt="npm" /></a>
  <a href="https://github.com/hrithikkoduri/anchor-ai-sdk/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/hrithikkoduri/anchor-ai-sdk/ci.yml?style=flat-square&label=ci&color=0f1115" alt="CI" /></a>
  <a href="https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/anchor-ai-sdk?style=flat-square&color=0f1115" alt="license" /></a>
  <img src="https://img.shields.io/node/v/anchor-ai-sdk?style=flat-square&color=0f1115" alt="node" />
</p>

---

Most agent harnesses give you a loop and leave the hard parts to you: a
context that grows until it dies, a trace you can't replay, a "done" you can't
trust. Anchor ships the hard parts.

- **Evidence, never vibes.** Every tool result is recorded on
  `AgentResult.evidence`; `run_tests` stamps the tree hash it ran against and
  `latestEvidenceForTree` ties a green run to the *exact* bytes (fail-closed
  when the tree can't be inspected). The engine carries evidence and never
  reads success out of a confident sentence — what to gate on it is your
  policy, not a hidden wall.
- **Durable by construction.** Conversation, workspace, and the agent's own
  notes survive folds, restarts, and budget deaths; the SDK ships the
  resumption primitives (thread store, checkpoints, phase pauses, revival
  planning), so resuming is wiring, not research.
- **Sandbox-first.** The machine is part of the design, not an afterthought:
  one provider contract, adapters accepted by an executable conformance
  suite.

## Out of the box

| | |
| --- | --- |
| **Agent loop with dials** | Budgets (steps / tokens / USD), repeated-call detection, silent-tool and verbose-turn advisories, a per-call output cap (16k, nudge at 8k; a capped prose turn continues once instead of ending), and assistant-text elision (20k replay, 12k head-only when capped, spilled and pointed at) — guardrails on by default, each with an off switch. Phases describe the approach — never a second gated execution engine. |
| **Streaming by default** | One wire path: every model call streams. Text and reasoning deltas, tool calls, compaction, checkpoints, and finishes all arrive as typed events. |
| **Durable memory** | `ThreadStore` carries conversation across runs; compaction is derived from the model's *real* context window; reasoning is journaled but never re-sent. |
| **Notes & spill storage** | A reserved `.anchor/notes.md` (git-excluded, checkpoint-carried) is the agent's durable memory across folds; oversized tool output spills to sandbox files and stays addressable instead of vanishing. |
| **Revival** | A dying run leaves a handoff (`request_revival`); `planRevival` + `ThreadBudget` decide how to fund the next run — **same task, phase, and budget** — and when the thread's caps are spent, a human gets the note, quoting the agent's own words on what remains. |
| **Snapshots & resume** | A pluggable snapshot hook (git-backed by default, push optional), phase-boundary pauses, heartbeats and cross-process cancel polling owned by the engine. |
| **Traces you can replay** | One fanout: one sequence number, redaction applied before *every* sink — NDJSON file, database rows, and a live projector share the same ordering. |
| **Sandbox plugins** | One `SandboxProvider` contract: Heyo microVMs, Docker, local. Capabilities are promises — the conformance suite holds adapters to them. Store-backed sessions give adopt-and-fallback continuity for free. |
| **Typed handoffs** | `finish({ handoff })` is shaped by *your* JSON schema; the engine declares the parameter, carries the object, and never interprets it. |
| **Priced & windowed models** | `llmFromCatalog` reads live prices and the genuine context window from the provider catalog — budgets and compaction configure themselves correctly. |

## Ten lines to a working agent

```bash
npm install anchor-ai-sdk
```

```ts
import { chatAgent, llmFromCatalog, runAgent } from "anchor-ai-sdk";

const { llm } = await llmFromCatalog({
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_KEY!,
  model: "z-ai/glm-5.3",
});

const result = await runAgent(
  { task: "Explain what this repository does" },
  { llm, agent: chatAgent },
);
console.log(result.summary);
```

## Give it a machine

```ts
import { codingAgent, runAgent } from "anchor-ai-sdk";
import { docker } from "anchor-ai-sdk/sandbox/docker";

const sandbox = docker().create({
  repoUrl: "https://github.com/you/your-repo",
  ref: "main",
});
await sandbox.start();
try {
  const result = await runAgent(
    { task: "Run the tests and fix the failing case" },
    { llm, agent: codingAgent, sandbox },
  );
  console.log(result.summary, result.checkpointRef);
} finally {
  await sandbox.destroy();
}
```

Runnable versions of both snippets live in [`examples/`](https://github.com/hrithikkoduri/anchor-ai-sdk/tree/main/examples) — including
a non-coding agent (its own strategy and tool, no sandbox).

## Providers

| subpath | backend | status |
| --- | --- | --- |
| `anchor-ai-sdk/sandbox/heyo` | Heyo Cloud microVMs (Firecracker) | production path; conformance + live tests |
| `anchor-ai-sdk/sandbox/docker` | containers on the local daemon | conformance-tested in CI |
| `anchor-ai-sdk/sandbox/local` | this host, **no isolation** | dev / CI only |
| — | E2B, Daytona | planned |

A backend is "done" when `runSandboxConformance(provider)` from
`anchor-ai-sdk/testing` passes — exec fidelity, kill deadlines, env secrets,
checkpoints, retain/adopt, git identity, pushes, and `fork` where declared.
See [`src/sandbox/README.md`](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/src/sandbox/README.md) for the provider guide.

## Proof, not promises

- **Tests:** the engine, tools, trace layer, and every provider scenario run
  in CI — local conformance always, Docker conformance on a purpose-built
  image. Live microVM conformance is opt-in with your own Heyo credentials
  (the suite skips without them).
- **Genericity guards:** executable rules keep the package consumer-neutral —
  no product nouns, no env reads, SDKs behind subpaths. They run in the same
  suite as everything else.
- **Evaluation:** Anchor vs mini-swe-agent on SWE-bench Lite — same
  container, same model, same official grader — resolved the same 7/10 at
  roughly **one-third of the cost**
  ([`evals/benchmarks/swe-bench/results/comparison.md`](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/evals/benchmarks/swe-bench/results/comparison.md)).

## Status

**Early alpha (0.x).** The API will move before 1.0 — pin exact versions. The
[`DECISIONS.md`](https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/DECISIONS.md) is the engineering log: every API has a written
reason, and the reasons moved with the code when this repo was extracted from
its monorepo.

- Repo / issues: [github.com/hrithikkoduri/anchor-ai-sdk](https://github.com/hrithikkoduri/anchor-ai-sdk)
- Docs: [anchor-sdk.dev](https://anchor-sdk.dev) (coming)
- License: MIT
