# Anchor — decision log

Anchor grew inside the Sailor monorepo and moved here with its history (git
subtree split). Entries #51–#65 below were moved verbatim at extraction time;
the Sailor repo's `DECISIONS.md` keeps the full, combined log (including
Sailor-only decisions). The summaries of the earlier entries exist so the
reasons behind the API travel with the code; follow the Sailor repo's log for
their full text.

## How this log is classified

- **Architectural** — the package's shape: engine, sandbox contract,
  durability, data flows, protocols.
- **Cosmetic** — naming, presentation, docs.
- **Misc** — process, tooling, packaging.

| # | decision | class |
| --- | --- | --- |
| early | the summaries below — foundations | Architectural |
| #51 | agent-led execution, phases as approach | Architectural |
| #52 | SDK naming: say the noun, verb first | Cosmetic |
| #53 | the provider seam: capabilities as promises | Architectural |
| #54 | `llmFromCatalog` | Architectural |
| #55 | TraceSink + TraceFanout | Architectural |
| #56 | the run loop owns its lifecycle | Architectural |
| #57 | the genericity guard names products | Misc |
| #58 | revival policy + publication evidence | Architectural |
| #59 | session store + provider `prepare()` | Architectural |
| #60 | the legacy options bridge is gone | Architectural |
| #61 | provider folders, stubs, sandbox README | Cosmetic |
| #62 | naming locked, registry-verified | Cosmetic |
| #63 | the public tool/engine surface | Architectural |
| #64 | `finish()` carries a consumer-shaped handoff | Architectural |
| #65 | `anchor-ai-sdk` everywhere + publish guard | Misc |

## Early decisions that shaped the package (summarized at extraction)

- **#1 — `local` is a dev/test backend.** Heyo is the production sandbox;
  `LocalSandbox` implements the same interface for tests/daemon-less CI. It
  is not a configuration concept.
- **#3 — Tool call contract.** Every tool command is self-contained
  (`cd <repo> && …`) and carries a real kill deadline: an API timeout is not
  a process kill.
- **#5 — Checkpoints are git commits; resume = pull.** One mechanism covers
  crash-resume and best-of-N.
- **#12 — Single wire path for LLM streaming.** Every call streams; `complete()`
  aggregates; tool-call fragments assemble by index.
- **#16 — Publishable-ready rules from day one.** No `apps/` imports, no
  env reads, explicit deps, clean exports; this repo is the result.
- **#17 — Threads are framework-first.** `ThreadStore` interface +
  `MemoryThreadStore` in the package; databases are the consumer's.
- **#18 — Compaction lives in the engine**, before every turn, protocol-safe.
- **#19 — Everything but the LLM is optional** — as amended by #63: an agent
  or strategy is now required (no silent chat default).
- **#20 — Guardrail inventory**, always on by default, each with a dial.
- **#21/#22 — Best-of-N and durable turns split**: capability in the package,
  policy (rows, leases, sweeps) in the app.
- **#32 — `finish` is an engine intrinsic**, injected, never listed by
  consumers.
- **#34–#39 — Evidence over claims.** Test evidence is structured data tied
  to the exact tree (`meta.treeHash`); "green" only counts if the tree still
  matches (decision #38); publication is an explicit tool call, never
  inferred from turn success.
- **#42/#43 — Credentials are callbacks, not strings.** Installation tokens
  expire mid-run; the sandbox re-mints via `spec.git.token()`.
- **#44 — The repo gate** is applied at webhook intake (a Sailor concern;
  noted for context).
- **#51 — Agent-led execution**: phases are approach, not gates; side
  effects are explicit tools (`publish_changes`, `reply_on_github`); the
  prompt is composed from blocks; publication policy gates publication only.

## Decision #51 — agent-led execution, phases as approach, composed prompts

The runtime is one model/tools/observations loop. It does not reject completion
for missing test evidence or force a reproduce/fix/verify itinerary. A final
response ends an assistant turn, not a verification certificate or publication.
This supersedes the workflow-gate and implicit side-effect portions of the
earlier decisions; no legacy workflow runner is retained.

- **Meaningful phases:** understand → act → validate → respond describe a
  useful approach. `set_phase` records the agent's progress, permits skipping
  and revisiting, and never imposes evidence gates. Caller-controlled pauses,
  budgets, cancellation, sandbox isolation, and tool capability bounds remain.
- **Composed behavior:** the coding profile assembles named character/tone,
  judgment, operating rules, verification philosophy, phases, and context.
  Sailor specializes that exact profile with product identity and GitHub tools,
  rather than duplicating the agent or maintaining a different chat personality.
- **Honest task grounding:** the current request is the latest real user
  message. Internal controls are explicitly distinguished from conversation;
  normal runtime history handling does not guess by text prefix. A separate
  backed-up repair command cleans known historical orchestration directives
  from idle threads only, preserving the immutable trace journal.
- **Explicit side effects:** only `publish_changes` publishes and only
  `reply_on_github` posts a discussion reply. Repository selection is checked
  again at that boundary. Current-tree test evidence is reported independently;
  unverified new PRs are drafts. `SAILOR_REQUIRE_PASSING_TESTS=1` can withhold
  publication without keeping the conversation trapped in a retry loop.
- **Timeout truth:** Heyo runs commands as deadline-bound guest jobs observed
  with short API calls. Launches are not blindly replayed, unknown completion
  is not called a confirmed kill, and output collectors are supervised too.
  Live VM tests require an explicit `RUN_LIVE_HEYO_TESTS=1`.
- **Debug display:** ⌘⇧D / Ctrl+Shift+D reveals expandable tool input/output
  and red failure details, without changing agent permissions or behavior.
- **Conversation-loop corrections (same review):** dashboard sends queue and
  never cancel — the queued chip (phase row) carries Interject and, on hover,
  per-message withdraws; interjected messages land in the thread animated.
  Interruption is the explicit `/interject` action, matching the composer
  policy (#47); chat turns carry reply framing — answer first, then
  unfinished work continues after the reply unless the message redirects it;
  and after consecutive
  silent tool turns the engine may inject a runtime-only **materialization
  advisory** (`guardrails.toolOnlyNudgeLimit`, default 8, `false` disables) —
  advisory, dialable, never a gate. Reasoning is journaled, shown in chat and
  trace, never resent to the model; compaction is derived from the model's
  real window (fold at ~55%, clamped to the 200–300k working range with a
  recent-quarter tail; static 256k/64k only when the catalog is unreachable)
  so switching models cannot silently break or overrun it. It keeps
  findings instead of folding them into a re-read loop, and renders in the
  thread as an expandable handoff — fold counts, the summary carried forward,
  and (debug mode) the folded transcript.
- **Budget dials:** engine defaults stay conservative package policy; Sailor
  raises them for long-horizon work (`SAILOR_MAX_STEPS` / `SAILOR_MAX_TOKENS` /
  `SAILOR_MAX_USD`, defaults 300 / 150M / $5 per run — a fraction of the
  thread's $25 so revivals have room; overnight 1200 / 400M / 50. Defaults
  assume deepseek-flash prices: on a pricier model dollars bind first).
  Cumulative tokens grow with every call no matter how well compaction bounds
  the per-call context, so steps and dollars are the real dials — the token cap
  is only a runaway backstop.
- **Sandbox continuity (A + B):** live GitHub threads retain their sandbox and
  the next run adopts it (same workspace, edits intact); turn-boundary
  checkpoints are force-pushed to a `*-checkpoint` side branch the push webhook
  ignores, so a destroyed VM never loses the work. Terminal threads release the
  VM. Retention/adoption/push are Anchor capabilities, dogfooded through the
  package's own `openSandbox`/`releaseSandbox` lifecycle; the policy is
  Sailor's.
- **Toolchain image (step 16):** the sandbox stops being `heyo/bun:latest` —
  `image/Dockerfile` (Ubuntu 24.04 + Python/pip/pytest + Node 22 + build
  essentials + ripgrep) is built and pushed to the namespace's artifact store
  (`harness/sailor-toolchain:latest`) by `image/build.sh`. A VM boots able to
  run real test suites; `sailor sandbox smoke --toolchain` is the check.

## Decision #52 — SDK naming: say the noun, verb first

Public names must decode at a glance, the way you would say them out loud —
no internal metaphor in an export. The package's existing names already pass
this test (`runAgent`, `openSandbox`, `releaseSandbox`, `createLLMClient`),
and the provider refactor must not regress them: the review sketch's
`openWorkspace` and `runLifecycle`/`createRunner` never ship.

- **One noun per concept, everywhere:** the type is `Sandbox`, so the
  functions say `Sandbox` (`openSandbox`, `releaseSandbox`) — not
  "workspace", "session" or "runner". Internal helpers may be named anything;
  only exports face this test.
- **Verb + noun for actions:** `runAgent(task, opts)` — the loop and its
  lifecycle (sinks, heartbeat, `shouldCancel`, budgets) are options of one
  function, not a second `createRunner` object; `openSandbox({...})`,
  `releaseSandbox(handle)`, `planRevival(result, budget)`.
- **Options over compositor helpers:** `traceSinks: [jsonl, pg]` for the
  common case; a compose helper exists only if composing is genuinely awkward.
- **Providers are brand nouns behind subpaths:** `heyo({...})`, `local()`,
  later `e2b`/`daytona`, imported from `@anchor/core/sandbox/<name>`; the
  registry takes provider objects, not string enums.
- **Settled renames from the review sketch:** `SandboxHandleStore` →
  `SandboxStore` (where a thread's retained handle lives); `teeSinks` and
  `createRunner` are not exported.

## Decision #53 — The provider seam shipped: capabilities are promises, the conformance suite is the acceptance test

Phase 2 landed as PR #1 (merged, `e5413d9`). One contract —
`SandboxProvider` (`name` as a free-form string, `capabilities`,
`create`/`adopt`/`release`/`probe`) — and every consumer speaks it: Sailor's
`execute.ts`, `sailor run`, and `sailor smoke` build providers explicitly
through one `heyoProvider(cfg)` translation point; handles carry
`provider.name` verbatim, so no future backend can be misclassified as heyo
(both `backend === "local" ? … : "heyo"` ternaries are gone).
`createSandbox` and its options union were removed pre-publish — zero callers
after the migration; `provider.create(spec)` is the replacement.

- **SDK isolation is proven, not aspirational:** the root entry loads with
  `@heyocomputer/hws` physically removed from `node_modules`; the `heyo` and
  `local` factories live behind `@anchor/core/sandbox/<name>` subpaths
  (with `upsertHeyoSecret` on the heyo subpath), and a genericity guard keeps
  the SDK and the test framework out of every other entry.
- **Capabilities are promises the suite holds you to.** `SandboxCapabilities`
  gains `localPath`; the conformance suite gates scenarios on declaration.
  First catch: `local()` declared `fork: false` while implementing `fork()`.
- **`runSandboxConformance(provider)` is the adapter acceptance test**
  (`@anchor/core/testing`, vitest as optional peer): exec fidelity,
  self-containment, kill deadlines, env secrets, checkpoints, destroy
  idempotence, retain/adopt, git identity, push-failure reporting — plus
  clone, `hasChangesFrom`, `localPath` copies, bare-origin pushes, and fork
  where declared. Scenario bodies assert through `Sandbox`/`SandboxProvider`
  only, never through backend internals. E2B/Daytona adapters are "done" when
  this file passes.
- **The live arm stays opt-in:** `RUN_LIVE_HEYO_TESTS=1` boots one VM per
  scenario; `ANCHOR_CONFORMANCE_REPO` enables the clone-shaped scenarios.

## Decision #54 — `llmFromCatalog`: one call from model id to correct configuration

Boundary A's first lift. Both consumers hand-rolled "catalog → prices →
compaction" — and that duplication caused a real bug: a whole eval round was
billed at stale `.env` prices (2x/10x off for GLM 5.3) because the precedence
rule lived in two files. One factory in `packages/core/src/llm/from-catalog.ts`:

    const { llm, catalog, compaction } = await llmFromCatalog({ baseUrl, apiKey, model });

- **Precedence is explicit:** explicit options win (operator intent — Sailor
  keeps env-price overrides), then the catalog, then silent degradation.
  The eval passes no overrides on purpose: there the catalog is the truth and
  an unreachable catalog reads as "cost unknown", never wrong.
- **Compaction derives from the real window** (`compactionForContextWindow`,
  clamped to the 200–300k product range); `fallbackCompaction` covers offline.
- **Named verb-first** per #52: `llmFromCatalog` — "an LLM built from the
  catalog". The old `createLLMClient({ catalog: "auto" })` sketch is dead.
- Sailor's `catalogFor` + per-process catalog cache are gone; correctness in
  one place beats saving one `/models` GET per run.

## Decision #55 — TraceSink + TraceFanout: one stream, many sinks, one journal

Boundary A's second lift, shipped in two commits (`c48105c` + this one). A
`TraceSink { name, record(entry) }` and a `TraceFanout` in
`packages/core/src/trace/sink.ts`; a `TracedEvent` is the one sequenced,
deeply-redacted unit every sink records.

- **Sequencing is owned by the fanout.** The NDJSON file no longer assigns
  seqs and the recorder no longer borrows them; product bookkeeping rides an
  `afterRecord` hook on the recorder, so a dashboard nudge can never race the
  row a refresh would read.
- **Redaction moved up:** `redactEvent` runs once, deeply, before every sink
  (nested tool inputs included). A sink cannot forget it because it never
  knew the rules. Deliveries are serialized per sink; a broken sink goes to
  `onError` and the run continues. External tracing adapters (OTel later)
  plug in by implementing one method.
- **Projectors moved next to the schema** (`trace/live-projector.ts` — now a
  sink — and `trace/conversation.ts`). The live frame's `sequence` IS the
  journal seq, the same numbering replayed parts quote, so a reconnecting
  dashboard splices live frames onto replayed parts exactly. Sailor's copies
  are deleted; the dashboard keeps its wire-local `ConversationPart` type.
- The `runAgent` lifecycle lift will accept `traceSinks` directly; today
  consumers compose the fanout themselves (execute.ts, `sailor run`).

Tests: one shared entry instance across sinks (one seq, one deep redaction),
per-sink serialization under load, failure containment, NDJSON ordering
unchanged, recorder sequencing + `afterRecord` ordering, and the projection
suites (live driven through a fanout — which is how the redaction assertion
now proves the live path is covered).

## Decision #56 — The run loop owns its lifecycle: sinks, heartbeat, cancel

Boundary A's third lift. `EngineOptions` gains `traceSinks`, `heartbeat`, and
`cancel`; `runAgent` now owns everything every consumer was hand-rolling
around it:

- **`traceSinks`** — the engine builds one `TraceFanout` per run (one
  sequence number, one redaction, flushed before the result — `run_finished`
  included). `onEvent` still receives raw events for live consumers, and a
  throwing subscriber can no longer kill the run (same rule as sinks).
- **`heartbeat: { everyMs, beat }`** — first beat immediate, failures
  swallowed, timer stopped on every exit **however the run ends**: all exits
  pass through `conclude()`, which clears timers and flushes sinks. Timers
  start after all throwing setup, so a failed context prepare cannot leak a
  beater. Sailor passes `heartbeatRun(db, run.id)`; `withHeartbeat` is
  deleted from `lease.ts`.
- **`cancel: { everyMs, isCancelled }`** — polled and merged with the
  caller's `signal` into one internal controller: the signal stays the
  in-process fast path, the poll is the cross-process one (a durable flag any
  process can stamp). Truthy → concludes `cancelled`. Sailor's `cancelWatch`
  interval is deleted.
- **Status vocabulary stays product.** Mapping `FinishReason` → row status
  (`budget_exhausted`, `interrupted`, …) is Sailor's call, not the package's;
  the engine returns reason/ok/usage and nothing product-shaped.
- execute.ts net −50 lines (heartbeat wrapper, cancel watch, fanout wiring,
  second flush all gone); its trace setup is now "build sinks, hand them
  over". lease.ts −19.

Tests: both sinks receive the identical full-run sequence and were flushed
before the result; a broken sink is contained; the heartbeat fires
immediately and stops with the run; a polled cancel concludes `cancelled`
mid-call. Core 179.

## Decision #57 — The genericity guard names products (src + fixtures)

`packages/core` may not name consumer products. The guard in
`tests/unit/genericity.test.ts` scans `src/` AND `tests/`, carries a positive
control (the rule proves it can fire), and reads every file but itself. The
fix for a hit is to make the code generic or move it to the product — never
to whitelist a file. First pass cleaned the conformance suite's fixtures
(`sailor/issue-7-checkpoint` → `anchor/issue-7-checkpoint`,
`sailor-app-dev[bot]` → `anchor-test[bot]`) and three comments. Ecosystem
nouns stay allowed — the docker adapter documents SWE-bench images, which is
interoperability, not product.

The pass surfaced a real extraction blocker, now in DEFERRED: the engine and
watch suites import `fixtures/buggy-lib` via `../../../../fixtures` — outside
the package after the subtree split.

## Decision #58 — Revival policy and publication evidence are package primitives

Boundary B's first lift — the last engine logic the product owned. Two pure
primitives in `packages/core/src/engine/` (revival.ts is now exported from
the root; it was internal until now):

- **`planRevival(result, task, threadBudget) -> RevivalPlan`** — the pure
  decision (`revive` / `needs_human` / `none`): a run that died of budget
  (`budget_exceeded` | `max_steps`) with a handoff (request and/or checkpoint)
  continues with the SAME task, phase, and budget; once the thread's own caps
  are spent, a human gets the note — which still quotes the agent's own words
  about what remains. `ThreadBudget` (turns + dollars across runs, exhausted
  at either cap, `record({ usd })` per run) is the accumulator.
- Persistence stays product: Sailor's `handleBudgetAftermath` keeps the rows,
  the `revived` idempotence flag, and the note insert; the hand-rolled
  `budgetLeft` comparison and local `remainingText` are gone.
- **`latestEvidenceForTree(sandbox, events)`** — decision #38's consumer half:
  stage (`git add -A`), `git write-tree`, find the latest `run_tests` with
  `meta.ran`, and answer `passed` / `failed` / `not_verified` for THAT tree;
  an uninspectable tree is `inspected: false`, so publication paths fail
  closed — never "nothing to verify". `publish_changes` calls this instead of
  its inline copy.
- One behavior note: a revived run's task is now always a string (the
  `"(no task recorded)"` placeholder) rather than potentially null — matching
  what the engine already substitutes at run time.

Tests: the revival crossroads (request / checkpoint-only / caps spent / no
evidence / non-budget reason), accrual at both caps, and the tree rule
(fresh pass, fresh fail, stale tree, no run). Core 186.

## Decision #59 — Boundary B closes: the session store and provider prepare()

Two lifts finish the "pull the primitives home" queue:

- **`openSandboxSession` + `SandboxStore`** (`sandbox/index.ts`): the package
  owns the continuity policy end to end — adopt the retained handle, clear the
  store when it is gone, then try sources newest-usable-first (a dead ref is
  reported via `onRefUnusable` before the next candidate), and write back
  whatever opened. `SandboxStore` is `get`/`set`/`clear` on opaque keys;
  `MemorySandboxStore` ships for tests and demos. What stayed product: the
  Postgres implementation (`threads/sandbox-store.ts` — the thread row's
  sandbox columns) and the `checkpointRef` bookkeeping. `openSandbox` with
  explicit callbacks remains for one-shot consumers.
- **`SandboxProvider.prepare({ gitToken })`**: optional, best-effort pre-run
  maintenance. The Heyo provider now gates and performs the git-kind
  build-secret refresh itself (`buildSecretRefresh` moved onto
  `HeyoSandboxConfig`), so Sailor's execute.ts contains no `cfg.heyo.*` check
  for it — just `provider.prepare?.({ gitToken })` with a log-and-continue
  policy. The caller decides fatality; the provider owns the mechanics.

Also recorded: the package's suites no longer read the repo-root
`fixtures/buggy-lib` (they scaffold it in-test), resolving the DEFERRED
extraction blocker by decoupling — Sailor's integration tests keep using the
fixture, which is fine: it is a product fixture.

## Decision #60 — The legacy options bridge is gone

`providers.ts` (`CreateSandboxOptions` + `providerFor`) and the legacy paths
in `openSandbox`/`releaseSandbox` are deleted. Explicit providers have been
the only shape since #53, and the bridge was the last place a "which backend?"
guess existed — the `{ local } | { heyo }` options shape inferred the
provider. Its only consumer was the lifecycle test, rewritten to drive
`local({ rootDir })` directly (the more honest test: it exercises what
products drive). `releaseSandbox(handle, provider)` is positional now — no
options object to smuggle a backend through; `openSandbox` requires a
provider and keeps only the explicit callbacks. The lazy bridge import
disappears with it, so the root entry's SDK-free property is structural
(subpath imports only), not dependent on a dynamic import.

Core 188 / server 54 with zero `providerFor`/`CreateSandboxOptions`
references left in the repo.

## Decision #61 — Provider folders, E2B/Daytona stubs, and the sandbox README

The sandbox layer groups by provider now: `heyo/{index,exec,secret}`,
`docker/index`, `local/index` (all `git mv` — history preserved), plus `e2b/`
and `daytona/` stub subpaths whose factories throw with a pointer to the
README. Consumer subpaths (`@anchor/core/sandbox/*`) and the contract are
unchanged; `package.json` exports point at the new entries. `local` stays as
the documented dev/CI backend (no isolation): removing it would make the
package's own suite daemon-dependent.

`sandbox/README.md` is the architecture guide: each `SandboxProvider` member's
promise, what `start()` must guarantee, the shared infra a backend inherits
(`gitAccess()` → checkpoints/reserved scratch; the exec contract with the
never-replay-an-ambiguous-launch rule and the Heyo 30s-ceiling case study),
`runSandboxConformance` as the acceptance test, and an "adding a provider"
checklist.

One hidden coupling found on the way: `apps/server/vitest.config.ts` pinned
the old subpath _file_ targets as exact aliases (mirroring the tsconfig paths
entry) — `DEBUG=vite:resolve` showed resolution still landing on the deleted
`local.ts`. A package reorg must sweep consumer aliases, not just imports.

## Decision #62 — Naming locked, verified against the registry

The reviewer agent was right and I was wrong: the `@anchor` scope is
unpublishable — an npm **user** named `anchor` exists (the registry's
`maintainer:anchor` search shows their packages), and scope ownership follows
the user/org name, not the published-package list. Verified 2026-10-19:
`anchor-sdk` (unscoped) taken; `@anchor-sdk/*` taken (user `jinmax2025`);
`@anchor/core` not publishable by us; `anchor-ai-sdk` **free**.

**Locked:** npm `anchor-ai-sdk` · GitHub repo + docs domain `anchor-sdk`
(`anchor-sdk.dev`) · brand **Anchor**. The monorepo keeps the workspace name
`@anchor/core`; the rename happens at extraction (package.json + one
find/replace across Sailor/evals), so no churn now. Claim the npm name early
— register the `anchor-ai-sdk` package with a stub release, or at least
reserve it — before someone else does.

## Decision #63 — The public tool/engine surface is consumer-neutral

Shipped `aa6b6b1`, before the split froze it as contract:

- `testCommand` removed from `RunTask` and `ToolContext`. run_tests owns its
  fallback: `runTestsTool({ defaultCommand })`, composed by
  `createCodingTools({ testCommand })` / `createCodingAgent({ testCommand })`.
  The full-suite-evidence rule is unchanged; it just lives with the tool.
- No silent `chatStrategy` default: `runAgent` requires an agent or a
  strategy, with an error that says so.
- `SandboxCapabilities` lost its `[flag: string]: boolean` index signature
  (typos type-checked); provider-specific flags live in
  `extra?: Record<string, boolean>`.
- `HeyoSizeClass` moved out of the generic `sandbox/types.ts` into the heyo
  subpath.

## Decision #64 — finish() carries a consumer-shaped handoff

The biggest remaining Sailor leak is gone. `finish` is now
`finish({ summary, success?, handoff? })` where the handoff's shape comes
from the consumer: `EngineOptions.handoff = { schema, description?,
threadPhase? }` declares the parameter from a JSON schema, the engine carries
the model's object to `AgentResult.handoff` untouched, and `threadPhase`
derives the resume phase the thread persists. Deleted from the engine:
`RunDisposition`, `disposition`/`watch`/`resumeAt` on `AgentResult`, the
run_finished event's `disposition`, and the loop's defaulting logic. Sailor
owns the old vocabulary as `SAILOR_HANDOFF` (`agents/sailor-handoff.ts`) plus
`readSailorHandoff()` — the rows, thread state, and worker log are unchanged.
A handoff without a configured schema is a tool error. Core 190 (+2), server
54; the engine contains no occurrence of the old words.

## Decision #65 — `anchor-ai-sdk` everywhere, and publishing has a guardrail

Added just before extraction (supersedes #62's "rename at extraction" plan):
the package is `anchor-ai-sdk` in the monorepo already, so the consumer
switchover is a dependency-source swap with zero import churn.
`scripts/prepare-publish.mjs` flips entry points to dist;
`scripts/verify-dist-exports.mjs` (prepublishOnly) refuses a src-flavored
publish. Snapshot failures emit a `snapshot_failed` advisory instead of a
silent catch. The extraction uses git filter-repo over all three historical
eras (root `src/{llm,sandbox,tools}` → `packages/agent` → `packages/core`),
not subtree split.
