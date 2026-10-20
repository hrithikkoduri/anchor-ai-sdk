# Website claim audit

Reviewed against SDK source **193963a** and the installed, published
`anchor-ai-sdk@0.1.7` package. This adds native inbox chains, background delivery,
custom sandbox-exec tool opt-in, runtime provenance, and pending-job resume to
the earlier source/eval audit. No SDK source was changed by this audit. Public
imports and offline behavior are checked against the published package; this
does not certify live provider deployments.

This is a content/source audit plus explicitly scoped offline checks, not a
blanket statement that every supported service and workload was exercised.

## Findings and resulting wording

| Surface / claim | Implementation examined | Supported statement and limits |
| --- | --- | --- |
| Agent runtime | `src/engine/loop.ts`, `strategy.ts`, `types.ts`, `src/agents/types.ts` | The engine dispatches model tool calls, records results, and returns an outcome. `Agent` is a strategy/tool bundle. Phases describe approach; they are not authorization, a workflow graph, or test gates. |
| Execution evidence | `src/tools/run-tests.ts`, `src/engine/evidence.ts`, `src/engine/loop.ts` | `AgentResult.evidence` holds tool name, `ok`, and metadata. Test commands record exit/timeout/timing and optional **post-run** Git tree hashes. Full text is in tool-result events, not each evidence record. |
| Freshness | `latestEvidenceForTree` | It stages the current tree, compares it to the latest executed `run_tests` event, and uses that event's `ok`. It does not check test assertions, require `defaultCommand`, cover ignored/external inputs, attest trust, or create an immutable execution snapshot. Missing/uninspectable Git state is not a pass. |
| Budget and course correction | `src/engine/budgets.ts`, `loop.ts`, `types.ts` | Defaults: 40 turns / 3M tokens / $5 known cost; usage is checked between calls, so overspend is possible. Per-call output limit is requested from the provider (16k); verbose nudge is 8k **visible** output tokens after subtracting reported reasoning. Repeated/empty/capped/nudge-related cases have bounded recovery logic, not a guarantee of progress. Only the documented public controls can be tuned; empty-turn retries and advisory wording are not separate options. |
| Memory and spill | `thread.ts`, `compaction.ts`, `elision.ts`, `src/tools/truncate.ts`, `src/sandbox/git.ts` | A supplied thread store persists summary/messages/phase at run boundaries. Compaction summarizes older context. Notes are agent-authored files carried by checkpoints. Initial `.git/info/exclude` does not permanently hide a force-added/tracked notes file from all Git diffs. Spill is best-effort and capped at 4M characters. No general lossless-storage guarantee. |
| Revival | `src/engine/revival.ts`, `loop.ts` | Opt-in warning/handoff mechanics and a pure revival planner. The app records spend, persists state, funds/queues another run, and escalates. A checkpoint can also provide handoff evidence; a model request is not guaranteed. |
| Snapshots | `src/engine/snapshot.ts`, `src/sandbox/git.ts` | Default hook checks for changes and commits on finish/pause. Optional push and failures are reported. Git durability and preservation depend on successful checkpoints, retention, and/or off-machine storage. |
| Model client and catalog | `src/llm/openai-compatible.ts`, `from-catalog.ts`, `catalog.ts` | The built-in client sends streaming requests. Catalog metadata can configure prices and compaction; failure falls back. Context estimation is heuristic and catalog values/provider behavior can vary. Reasoning events depend on provider-reported reasoning. |
| Traces | `src/trace/sink.ts`, `redact.ts`, `jsonl.ts`, `live-projector.ts`, `conversation.ts` | Configured trace sinks share sequence and pattern-based redaction. Raw `onEvent` is not redacted. Sink exceptions are isolated; a sink promise that never settles can delay flush. This is not complete secret detection or automatic durable logging without a sink. |
| Native inbox | `src/engine/inbox.ts`, `loop.ts`, `types.ts` | `inbox: { store, channel, render? }` checks interjections at safe boundaries and claims batches between runs. Queue leaves the active run untouched. Ordering includes every message: interjections newest-first, queues oldest-first; no automatic dropping of older corrections. Finished/interrupted/stalled can continue; errors/cancel/pause/budgets stop. Chain usage is cumulative, run summaries carry deltas. The host owns worker wake-up, durable storage/leases and authorization. Store failures can be swallowed; not exactly-once. IDs should be globally unique because settlement has no channel argument. |
| Background tools | `src/tools/types.ts`, `bash.ts`, `src/engine/dispatch.ts`, `background.ts`, `loop.ts` | `defineTool` captures background permission; host threshold and poll-capable sandbox are also required. A custom handler passes exec options and returns background metadata plus command/deadline. `execPolicy` is internal, not a public root export in 0.1.7. Bash participates, run_tests remains synchronous. Arbitrary host promises are not automatically detached. |
| Background delivery/resume | `loop.ts`, `src/llm/types.ts`, `src/engine/thread.ts` | Engine polls before model calls and waits before normal completion unless pending inbox work can continue. Jobs carry automatically through inbox chains; final pendingJobs must be persisted and restored as resumeJobs on the same retained machine. Runtime completion facts survive conversationHistory filtering, unlike transient engine advisories. Origin is UI provenance, not secrecy. Output uses bounded truncate/spill; completion events do not include full output bodies. A trace is not a lossless background-output archive. Sequence/step restart per subrun; use a chain ID plus segment and seq. |
| Tool editing | `src/tools/edit-file.ts` | A unique exact match is replaced; a byte **count** is checked afterward. Avoid the stronger phrase "byte-verified" as if a full content digest were compared. |
| Handoff schemas | `src/tools/finish.ts` | A schema is declared to the model, then an object is carried through the result. The implementation checks object shape, not full JSON Schema/business validity. Consumer-side validation is needed. |
| Sandbox abstraction | `src/sandbox/provider.ts`, `types.ts`, `index.ts` | One agent-independent provider/machine interface. Factories construct, `start` boots, adapters implement exec, checkpoints, teardown, and declared optional capabilities. Vendor boot configuration and guarantees are not interchangeable. |
| E2B | `src/sandbox/e2b/index.ts`, `exec.ts`, `tests/unit/e2b*.test.ts` | Implemented template-based adapter with retain/fork/remoteCheckpoint flags. No arbitrary Docker image at create time. Host-path import and egress control are not exposed. Offline tests and a credential-gated live conformance entry exist. |
| Heyo | `src/sandbox/heyo/index.ts`, `exec.ts`, `secret.ts` | Image is provider configuration, with artifact/dockerfile/git kinds. Per-run `image` and `workspacePath` are rejected. Retain and remote checkpoints are declared; native fork, host-path import, and egress control are not. Poll/kill support enables engine-managed background delivery; detached jobs can outlive a call and require host cleanup/resume. Direct sandbox.exec without the engine remains caller-managed. |
| Docker | `src/sandbox/docker/index.ts` | Explicit container image is required in provider options or `spec.image`. CLI and daemon must exist. `workspacePath` needs a prepared Git workspace; it skips clone. Retain/remoteCheckpoint and (in a562de3) egress control are declared; fork and host-path are not. `spec.egress: "none"` disconnects attached networks after startup; the other adapters reject it. This is not a universal isolation/security guarantee. |
| Local | `src/sandbox/local/index.ts` | Real host processes, **no isolation**. Optional host-path copying, retained directories, and checkpoint-based copying for fork. Not a production security boundary. |
| Conformance | `src/testing.ts`, integration test entries, `.github/workflows/ci.yml` | One public-contract scenario suite, gated by capabilities, fixtures, credentials, and skip configuration. Local/Docker jobs are configured in CI. Live Heyo/E2B runs require explicit opt-in. Do not infer live passes from the existence of test files or describe this as a security audit. |
| Benchmarks | `results/glm53-parasail/*`, `results/glm53-mini/*` under `evals/benchmarks/swe-bench/` | The completed records show 9/10 each. Anchor's sympy patch is unresolved; mini's matplotlib patch extraction failed with index.lock and its recorded patch is empty, not a hidden-test model failure. Both name direct Parasail GLM 5.3, temperature 0, seed 42 and Docker tasks, but budget policies differ. Anchor records 11,363,962 tokens / $4.31618636; mini omits per-task usage. Its run-level 0 USD must not be interpreted as free. No relative cost/token or general superiority claim is supported. The older 7/10 OpenRouter baseline is separately labeled historical. |
| Planned vs implemented | `package.json`, provider factories, `ROADMAP.md` | E2B is implemented and exported, not planned. Daytona is not exported. Agent teams and consumer skill bundles remain roadmap work in the reviewed source. Version availability must be checked separately. |

## Checks performed

- Direct source reads of the above modules, provider constructors/options,
  declared capabilities, lifecycle paths, test files, and CI configuration.
- Five isolated evidence reproductions against the current source:
  - `run_tests({ command: "true" })` can yield freshness `passed`.
  - Checking a file then changing it inside the command records the changed,
    post-command tree and can yield `passed`.
  - A normal later non-ignored edit yields `not_verified`.
  - Changing an ignored input does not change the Git tree freshness result.
  - A final response can return `ok: true` without any test evidence.
- Four generated sandbox examples imported and constructed against bundles of
  the actual reviewed source. Fetch was blocked. No `start`, `probe`, cloud
  image/template build, or model call was performed by those smoke checks.
- The E2B template builder follows the repository's actual
  `scripts/build-e2b-template.mjs` API usage. Its remote build was not executed.
- Compaction, correction, revival, tool-building and streaming examples are
  checked against their public interfaces. Scope limits are documented: lossy
  summarization, application-owned persistence/queues, schema validation,
  raw versus redacted events, bounded live frames, and absent reasoning data.
- The detailed-docs smoke suite parses the shown snippets and checks named
  imports against the actual SDK. It executes the custom tool's validation,
  the same-process revival example (scripted budget exhaustion then finish),
  the custom sink, NDJSON recording, live projection, pattern redaction and
  conversation replay. It does not validate third-party cloud deployments.
- Published 0.1.7 checks additionally exercise the downloadable background
  tool, host threshold/provider capability/short deadlines, native queue and
  interject job carry, persisted runtime facts, pending-job resume, batch order,
  deduplication, cumulative/per-run usage, and chain-aware trace keys. All model
  and sandbox results in these checks are scripted, not live cloud executions.
- Completed eval records are checked by task against results, verdicts,
  manifests, grading summaries and saved patch digests. Missing mini usage is
  kept missing; wall time is summed task time rather than batch duration.
- Provider marks are sourced from official assets and used only for adapter
  identification, with Heyo first. Sources are in `assets/providers/README.md`.
- Browser tests cover the provider tabs/downloads, qualified evidence copy,
  public navigation, responsive layouts, and sampled text contrast.
- The website production build is checked separately from live SDK/backend
  execution. See `README.md` for repeatable commands.

## Before making stronger claims

An "exact tested bytes" guarantee would need a trustworthy, immutable tested
snapshot (not merely a post-run hash). A release gate must also select trusted
commands, determine the expected test scope, validate outcomes, and consider
inputs outside Git. The current primitives let applications build policies;
the SDK does not enforce those policies or prove correctness on their behalf.
