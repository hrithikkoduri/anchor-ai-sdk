# Anchor: decision log

Anchor grew inside the Sailor monorepo and moved here with its history (git
subtree split). Entries #51–#65 below were moved verbatim at extraction time;
the Sailor repo's `DECISIONS.md` keeps the full, combined log (including
Sailor-only decisions). The summaries of the earlier entries exist so the
reasons behind the API travel with the code; follow the Sailor repo's log for
their full text.

## How this log is classified

- **Architectural**: the package's shape: engine, sandbox contract,
  durability, data flows, protocols.
- **Cosmetic**: naming, presentation, docs.
- **Misc**: process, tooling, packaging.

| # | decision | class |
| --- | --- | --- |
| early | the summaries below: foundations | Architectural |
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
| #66 | set_phase at real transitions (prompt nudge) | Misc |

## Early decisions that shaped the package (summarized at extraction)

- **#1: `local` is a dev/test backend.** Heyo is the production sandbox;
  `LocalSandbox` implements the same interface for tests/daemon-less CI. It
  is not a configuration concept.
- **#3: Tool call contract.** Every tool command is self-contained
  (`cd <repo> && …`) and carries a real kill deadline: an API timeout is not
  a process kill.
- **#5: Checkpoints are git commits; resume = pull.** One mechanism covers
  crash-resume and best-of-N.
- **#12: Single wire path for LLM streaming.** Every call streams; `complete()`
  aggregates; tool-call fragments assemble by index.
- **#16: Publishable-ready rules from day one.** No `apps/` imports, no
  env reads, explicit deps, clean exports; this repo is the result.
- **#17: Threads are framework-first.** `ThreadStore` interface +
  `MemoryThreadStore` in the package; databases are the consumer's.
- **#18: Compaction lives in the engine**, before every turn, protocol-safe.
- **#19: Everything but the LLM is optional**: as amended by #63: an agent
  or strategy is now required (no silent chat default).
- **#20: Guardrail inventory**, always on by default, each with a dial.
- **#21/#22: Best-of-N and durable turns split**: capability in the package,
  policy (rows, leases, sweeps) in the app.
- **#32: `finish` is an engine intrinsic**, injected, never listed by
  consumers.
- **#34–#39: Evidence over claims.** Test evidence is structured data tied
  to the exact tree (`meta.treeHash`); "green" only counts if the tree still
  matches (decision #38); publication is an explicit tool call, never
  inferred from turn success.
- **#42/#43: Credentials are callbacks, not strings.** Installation tokens
  expire mid-run; the sandbox re-mints via `spec.git.token()`.
- **#44: The repo gate** is applied at webhook intake (a Sailor concern;
  noted for context).
- **#51: Agent-led execution**: phases are approach, not gates; side
  effects are explicit tools (`publish_changes`, `reply_on_github`); the
  prompt is composed from blocks; publication policy gates publication only.

## Decision #51: agent-led execution, phases as approach, composed prompts

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
  never cancel; the queued chip (phase row) carries Interject and, on hover,
  per-message withdraws; interjected messages land in the thread animated.
  Interruption is the explicit `/interject` action, matching the composer
  policy (#47); chat turns carry reply framing; answer first, then
  unfinished work continues after the reply unless the message redirects it;
  and after consecutive
  silent tool turns the engine may inject a runtime-only **materialization
  advisory** (`guardrails.toolOnlyNudgeLimit`, default 8, `false` disables);
  advisory, dialable, never a gate. Reasoning is journaled, shown in chat and
  trace, never resent to the model; compaction is derived from the model's
  real window (fold at ~55%, clamped to the 200–300k working range with a
  recent-quarter tail; static 256k/64k only when the catalog is unreachable)
  so switching models cannot silently break or overrun it. It keeps
  findings instead of folding them into a re-read loop, and renders in the
  thread as an expandable handoff; fold counts, the summary carried forward,
  and (debug mode) the folded transcript.
- **Budget dials:** engine defaults stay conservative package policy; Sailor
  raises them for long-horizon work (`SAILOR_MAX_STEPS` / `SAILOR_MAX_TOKENS` /
  `SAILOR_MAX_USD`, defaults 300 / 150M / $5 per run; a fraction of the
  thread's $25 so revivals have room; overnight 1200 / 400M / 50. Defaults
  assume deepseek-flash prices: on a pricier model dollars bind first).
  Cumulative tokens grow with every call no matter how well compaction bounds
  the per-call context, so steps and dollars are the real dials; the token cap
  is only a runaway backstop.
- **Sandbox continuity (A + B):** live GitHub threads retain their sandbox and
  the next run adopts it (same workspace, edits intact); turn-boundary
  checkpoints are force-pushed to a `*-checkpoint` side branch the push webhook
  ignores, so a destroyed VM never loses the work. Terminal threads release the
  VM. Retention/adoption/push are Anchor capabilities, dogfooded through the
  package's own `openSandbox`/`releaseSandbox` lifecycle; the policy is
  Sailor's.
- **Toolchain image (step 16):** the sandbox stops being `heyo/bun:latest`;
  `image/Dockerfile` (Ubuntu 24.04 + Python/pip/pytest + Node 22 + build
  essentials + ripgrep) is built and pushed to the namespace's artifact store
  (`harness/sailor-toolchain:latest`) by `image/build.sh`. A VM boots able to
  run real test suites; `sailor sandbox smoke --toolchain` is the check.

## Decision #52: SDK naming: say the noun, verb first

Public names must decode at a glance, the way you would say them out loud;
no internal metaphor in an export. The package's existing names already pass
this test (`runAgent`, `openSandbox`, `releaseSandbox`, `createLLMClient`),
and the provider refactor must not regress them: the review sketch's
`openWorkspace` and `runLifecycle`/`createRunner` never ship.

- **One noun per concept, everywhere:** the type is `Sandbox`, so the
  functions say `Sandbox` (`openSandbox`, `releaseSandbox`); not
  "workspace", "session" or "runner". Internal helpers may be named anything;
  only exports face this test.
- **Verb + noun for actions:** `runAgent(task, opts)`: the loop and its
  lifecycle (sinks, heartbeat, `shouldCancel`, budgets) are options of one
  function, not a second `createRunner` object; `openSandbox({...})`,
  `releaseSandbox(handle)`, `planRevival(result, budget)`.
- **Options over compositor helpers:** `traceSinks: [jsonl, pg]` for the
  common case: a compose helper exists only if composing is genuinely awkward.
- **Providers are brand nouns behind subpaths:** `heyo({...})`, `local()`,
  later `e2b`/`daytona`, imported from `@anchor/core/sandbox/<name>`; the
  registry takes provider objects, not string enums.
- **Settled renames from the review sketch:** `SandboxHandleStore` →
  `SandboxStore` (where a thread's retained handle lives); `teeSinks` and
  `createRunner` are not exported.

## Decision #53: The provider seam shipped: capabilities are promises, the conformance suite is the acceptance test

Phase 2 landed as PR #1 (merged, `e5413d9`). One contract:
`SandboxProvider` (`name` as a free-form string, `capabilities`,
`create`/`adopt`/`release`/`probe`), and every consumer speaks it: Sailor's
`execute.ts`, `sailor run`, and `sailor smoke` build providers explicitly
through one `heyoProvider(cfg)` translation point; handles carry
`provider.name` verbatim, so no future backend can be misclassified as heyo
(both `backend === "local" ? … : "heyo"` ternaries are gone).
`createSandbox` and its options union were removed pre-publish; zero callers
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
  idempotence, retain/adopt, git identity, push-failure reporting, plus
  clone, `hasChangesFrom`, `localPath` copies, bare-origin pushes, and fork
  where declared. Scenario bodies assert through `Sandbox`/`SandboxProvider`
  only, never through backend internals. E2B/Daytona adapters are "done" when
  this file passes.
- **The live arm stays opt-in:** `RUN_LIVE_HEYO_TESTS=1` boots one VM per
  scenario; `ANCHOR_CONFORMANCE_REPO` enables the clone-shaped scenarios.

## Decision #54: `llmFromCatalog`: one call from model id to correct configuration

Boundary A's first lift. Both consumers hand-rolled "catalog → prices →
compaction", and that duplication caused a real bug: a whole eval round was
billed at stale `.env` prices (2x/10x off for GLM 5.3) because the precedence
rule lived in two files. One factory in `packages/core/src/llm/from-catalog.ts`:

    const { llm, catalog, compaction } = await llmFromCatalog({ baseUrl, apiKey, model });

- **Precedence is explicit:** explicit options win (operator intent: Sailor
  keeps env-price overrides), then the catalog, then silent degradation.
  The eval passes no overrides on purpose: there the catalog is the truth and
  an unreachable catalog reads as "cost unknown", never wrong.
- **Compaction derives from the real window** (`compactionForContextWindow`,
  clamped to the 200–300k product range); `fallbackCompaction` covers offline.
- **Named verb-first** per #52: `llmFromCatalog`: "an LLM built from the
  catalog". The old `createLLMClient({ catalog: "auto" })` sketch is dead.
- Sailor's `catalogFor` + per-process catalog cache are gone; correctness in
  one place beats saving one `/models` GET per run.

## Decision #55: TraceSink + TraceFanout: one stream, many sinks, one journal

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
- **Projectors moved next to the schema** (`trace/live-projector.ts`, now a
  sink, and `trace/conversation.ts`). The live frame's `sequence` IS the
  journal seq, the same numbering replayed parts quote, so a reconnecting
  dashboard splices live frames onto replayed parts exactly. Sailor's copies
  are deleted; the dashboard keeps its wire-local `ConversationPart` type.
- The `runAgent` lifecycle lift will accept `traceSinks` directly; today
  consumers compose the fanout themselves (execute.ts, `sailor run`).

Tests: one shared entry instance across sinks (one seq, one deep redaction),
per-sink serialization under load, failure containment, NDJSON ordering
unchanged, recorder sequencing + `afterRecord` ordering, and the projection
suites (live driven through a fanout, which is how the redaction assertion
now proves the live path is covered).

## Decision #56: The run loop owns its lifecycle: sinks, heartbeat, cancel

Boundary A's third lift. `EngineOptions` gains `traceSinks`, `heartbeat`, and
`cancel`; `runAgent` now owns everything every consumer was hand-rolling
around it:

- **`traceSinks`**: the engine builds one `TraceFanout` per run (one
  sequence number, one redaction, flushed before the result: `run_finished`
  included). `onEvent` still receives raw events for live consumers, and a
  throwing subscriber can no longer kill the run (same rule as sinks).
- **`heartbeat: { everyMs, beat }`**: first beat immediate, failures
  swallowed, timer stopped on every exit **however the run ends**: all exits
  pass through `conclude()`, which clears timers and flushes sinks. Timers
  start after all throwing setup, so a failed context prepare cannot leak a
  beater. Sailor passes `heartbeatRun(db, run.id)`; `withHeartbeat` is
  deleted from `lease.ts`.
- **`cancel: { everyMs, isCancelled }`**: polled and merged with the
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

## Decision #57: The genericity guard names products (src + fixtures)

`packages/core` may not name consumer products. The guard in
`tests/unit/genericity.test.ts` scans `src/` AND `tests/`, carries a positive
control (the rule proves it can fire), and reads every file but itself. The
fix for a hit is to make the code generic or move it to the product, never
to whitelist a file. First pass cleaned the conformance suite's fixtures
(`sailor/issue-7-checkpoint` → `anchor/issue-7-checkpoint`,
`sailor-app-dev[bot]` → `anchor-test[bot]`) and three comments. Ecosystem
nouns stay allowed: the docker adapter documents SWE-bench images, which is
interoperability, not product.

The pass surfaced a real extraction blocker, now in DEFERRED: the engine and
watch suites import `fixtures/buggy-lib` via `../../../../fixtures`, outside
the package after the subtree split.

## Decision #58: Revival policy and publication evidence are package primitives

Boundary B's first lift: the last engine logic the product owned. Two pure
primitives in `packages/core/src/engine/` (revival.ts is now exported from
the root; it was internal until now):

- **`planRevival(result, task, threadBudget) -> RevivalPlan`**: the pure
  decision (`revive` / `needs_human` / `none`): a run that died of budget
  (`budget_exceeded` | `max_steps`) with a handoff (request and/or checkpoint)
  continues with the SAME task, phase, and budget; once the thread's own caps
  are spent, a human gets the note, which still quotes the agent's own words
  about what remains. `ThreadBudget` (turns + dollars across runs, exhausted
  at either cap, `record({ usd })` per run) is the accumulator.
- Persistence stays product: Sailor's `handleBudgetAftermath` keeps the rows,
  the `revived` idempotence flag, and the note insert; the hand-rolled
  `budgetLeft` comparison and local `remainingText` are gone.
- **`latestEvidenceForTree(sandbox, events)`**: decision #38's consumer half:
  stage (`git add -A`), `git write-tree`, find the latest `run_tests` with
  `meta.ran`, and answer `passed` / `failed` / `not_verified` for THAT tree;
  an uninspectable tree is `inspected: false`, so publication paths fail
  closed, never "nothing to verify". `publish_changes` calls this instead of
  its inline copy.
- One behavior note: a revived run's task is now always a string (the
  `"(no task recorded)"` placeholder) rather than potentially null: matching
  what the engine already substitutes at run time.

Tests: the revival crossroads (request / checkpoint-only / caps spent / no
evidence / non-budget reason), accrual at both caps, and the tree rule
(fresh pass, fresh fail, stale tree, no run). Core 186.

## Decision #59: Boundary B closes: the session store and provider prepare()

Two lifts finish the "pull the primitives home" queue:

- **`openSandboxSession` + `SandboxStore`** (`sandbox/index.ts`): the package
  owns the continuity policy end to end: adopt the retained handle, clear the
  store when it is gone, then try sources newest-usable-first (a dead ref is
  reported via `onRefUnusable` before the next candidate), and write back
  whatever opened. `SandboxStore` is `get`/`set`/`clear` on opaque keys;
  `MemorySandboxStore` ships for tests and demos. What stayed product: the
  Postgres implementation (`threads/sandbox-store.ts`, the thread row's
  sandbox columns) and the `checkpointRef` bookkeeping. `openSandbox` with
  explicit callbacks remains for one-shot consumers.
- **`SandboxProvider.prepare({ gitToken })`**: optional, best-effort pre-run
  maintenance. The Heyo provider now gates and performs the git-kind
  build-secret refresh itself (`buildSecretRefresh` moved onto
  `HeyoSandboxConfig`), so Sailor's execute.ts contains no `cfg.heyo.*` check
  for it; just `provider.prepare?.({ gitToken })` with a log-and-continue
  policy. The caller decides fatality; the provider owns the mechanics.

Also recorded: the package's suites no longer read the repo-root
`fixtures/buggy-lib` (they scaffold it in-test), resolving the DEFERRED
extraction blocker by decoupling; Sailor's integration tests keep using the
fixture, which is fine: it is a product fixture.

## Decision #60: The legacy options bridge is gone

`providers.ts` (`CreateSandboxOptions` + `providerFor`) and the legacy paths
in `openSandbox`/`releaseSandbox` are deleted. Explicit providers have been
the only shape since #53, and the bridge was the last place a "which backend?"
guess existed; the `{ local } | { heyo }` options shape inferred the
provider. Its only consumer was the lifecycle test, rewritten to drive
`local({ rootDir })` directly (the more honest test: it exercises what
products drive). `releaseSandbox(handle, provider)` is positional now: no
options object to smuggle a backend through; `openSandbox` requires a
provider and keeps only the explicit callbacks. The lazy bridge import
disappears with it, so the root entry's SDK-free property is structural
(subpath imports only), not dependent on a dynamic import.

Core 188 / server 54 with zero `providerFor`/`CreateSandboxOptions`
references left in the repo.

## Decision #61: Provider folders, E2B/Daytona stubs, and the sandbox README

The sandbox layer groups by provider now: `heyo/{index,exec,secret}`,
`docker/index`, `local/index` (all `git mv`, history preserved), plus `e2b/`
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
entry); `DEBUG=vite:resolve` showed resolution still landing on the deleted
`local.ts`. A package reorg must sweep consumer aliases, not just imports.

## Decision #62: Naming locked, verified against the registry

The reviewer agent was right and I was wrong: the `@anchor` scope is
unpublishable: an npm **user** named `anchor` exists (the registry's
`maintainer:anchor` search shows their packages), and scope ownership follows
the user/org name, not the published-package list. Verified 2026-10-19:
`anchor-sdk` (unscoped) taken; `@anchor-sdk/*` taken (user `jinmax2025`);
`@anchor/core` not publishable by us; `anchor-ai-sdk` **free**.

**Locked:** npm `anchor-ai-sdk` · GitHub repo + docs domain `anchor-sdk`
(`anchor-sdk.dev`) · brand **Anchor**. The monorepo keeps the workspace name
`@anchor/core`; the rename happens at extraction (package.json + one
find/replace across Sailor/evals), so no churn now. Claim the npm name early
. Register the `anchor-ai-sdk` package with a stub release, or at least
reserve it, before someone else does.

## Decision #63: The public tool/engine surface is consumer-neutral

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

## Decision #64: finish() carries a consumer-shaped handoff

The biggest remaining Sailor leak is gone. `finish` is now
`finish({ summary, success?, handoff? })` where the handoff's shape comes
from the consumer: `EngineOptions.handoff = { schema, description?,
threadPhase? }` declares the parameter from a JSON schema, the engine carries
the model's object to `AgentResult.handoff` untouched, and `threadPhase`
derives the resume phase the thread persists. Deleted from the engine:
`RunDisposition`, `disposition`/`watch`/`resumeAt` on `AgentResult`, the
run_finished event's `disposition`, and the loop's defaulting logic. Sailor
owns the old vocabulary as `SAILOR_HANDOFF` (`agents/sailor-handoff.ts`) plus
`readSailorHandoff()`: the rows, thread state, and worker log are unchanged.
A handoff without a configured schema is a tool error. Core 190 (+2), server
54: the engine contains no occurrence of the old words.

## Decision #65: `anchor-ai-sdk` everywhere, and publishing has a guardrail

Added just before extraction (supersedes #62's "rename at extraction" plan):
the package is `anchor-ai-sdk` in the monorepo already, so the consumer
switchover is a dependency-source swap with zero import churn.
`scripts/prepare-publish.mjs` flips entry points to dist, while
`scripts/verify-dist-exports.mjs` (prepublishOnly) refuses a src-flavored
publish. Snapshot failures emit a `snapshot_failed` advisory instead of a
silent catch. The extraction uses git filter-repo over all three historical
eras (root `src/{llm,sandbox,tools}` → `packages/agent` → `packages/core`),
not subtree split.

## Decision #66: set_phase at real transitions (prompt nudge)

The phases stayed labels, and the label was never written: across the first
full live thread on the new engine (3 runs, 54 steps), the model never called
`set_phase`, so the dashboard's phase timeline read "understand" forever. The
prompt now asks for it in the model's own terms: "when your work shifts
between kinds of activity: investigating, changing code, verifying,
answering: call set_phase once to record the new phase." The non-gating
contract is unchanged (it never authorizes or blocks anything); the old "do
not call it as ceremony" framing, which read as permission to skip, is
gone. Small wording, real consequence: the timeline reports the actual
approach instead of a constant.

## Decision #68: a lost exec receipt fails one command, never the sandbox

A Heyo guest job can lose its completion receipt (a detached Chromium/Playwright
repro did): the client kept the job "pending" forever, so every later command
was refused with "previous command is still running", and the run died `blocked`
with no code changed. The executor now keeps a per-sandbox job registry, and a
job past its guest-side deadline (the supervisor's `timeout -k` already fired)
is killed in the guest and its receipt directory removed before the call is
failed. The kill pattern is expanded inside the guest from a uuid variable, so
the control command's own command line can never match it. Mutations keep the
safety gate: they wait while an unresolved job is still inside its deadline;
but a lost receipt can no longer wedge every later command. Regression:
`tests/unit/heyo-exec.test.ts`.

## Decision #69: read-only tools run concurrently, mutations stay serial

A model turn that returns several `read_file`/`search` calls now dispatches
them together instead of one round trip per file; results still reach the
conversation in the model's call order. The engine takes the parallel path
only when *every* call in the turn is `readOnly`: a mixed turn stays
sequential, and `finish`/`set_phase`/`bash`/`edit_file`/`run_tests` never run
concurrently. The sandbox opts in per call via `ExecOptions.concurrent`
(Heyo's executor allows multiple jobs; mutations keep the unresolved-job
gate). Regression: `tests/unit/parallel-reads.test.ts`.

## Decision #70: background commands are a delivery problem, not a timeout

A shell command that outlives a turn used to hold the turn to its deadline and
then be killed. Now `ExecOptions.backgroundAfterSecs` detaches it: the exec
returns `background: { jobId }` at the threshold while the guest job keeps
running, and `timeoutSecs` becomes the job's hard lifetime (the bash tool uses
the 3600s cap when the model set no deadline). The engine emits
`background_started`; the consumer (not the model) owns polling and delivery.
Sailor persists the handle (`background_jobs`), polls it from the worker sweep
through the thread's *retained* sandbox, and appends a `background_result`
inbox event, so completion arrives as the next turn through the existing
drain. No run is cancelled and the model never polls.

Two invariants make it safe: a detached job does **not** gate later mutations
(it is deliberately still running), and the sandbox must outlive the run. The
Heyo adapter makes retention a property of the result (`spec.retain = true`)
and `destroy()` refuses to park the VM while the executor has jobs, and parking
scales to zero and would kill them; the consumer parks after its last poll. A
job past `timeoutSecs + 90s` with no receipt is killed and reported `lost`, the
same fail-fast rule as decision #68. Regressions:
`tests/unit/background-exec.test.ts`, `tests/unit/heyo-exec.test.ts`.

## Decision #71: Teams are delegation mechanics, the roster is consumer policy

The run pipeline is deliberately one agent, one loop, one conversation, and
that is still the default. But some work wants roles that should not share a
context: the author of a fix is the worst judge of it, and an investigator
benefits from not inheriting the implementer's assumptions. The mistake to
avoid is the usual one: letting "multi-agent" become an orchestration
framework the consumer must program. So the split is drawn the way everything
else in this package is: **Anchor owns the delegation mechanics, the consumer
owns the roster.**

Mechanics (package): a `TeamSpec` (`lead` + `teammates[]`, each a normal
`AgentSpec` plus an optional tool subset and budget share); a `delegate` tool
the engine injects into the lead only, schema `{ teammate, task, context? }`,
with the teammate resolved by the engine, never by the model. A delegation runs
a **nested engine loop** against the same sandbox, emits
`delegation_started` / `delegation_finished`, and returns the teammate's final
text as the `delegate` tool result. Depth is 1 unless the consumer sets an
explicit cap. Only the lead can `finish()`: a teammate's result is a tool
result, so the consumer-shaped handoff of #64 is unchanged and no product
disposition case is invented.

Four invariants make it safe, and they are the reason this is a small feature
rather than a framework:

- **One sandbox, one budget.** Teammates share the workspace and the run's
  budget; delegated usage is charged to it, and a per-teammate cap returns a
  structured failure. Mutations keep the single-flight gate; concurrent
  read-only teammates are a later step built on #69, not part of v1.
- **Context isolation is the point.** Only the final text crosses back; the
  teammate's transcript is trace-only. Delegation is not a way to give the
  model more context, and the API should never be used that way.
- **Failure is local.** A teammate error, timeout, or cap breach returns a tool
  result the lead can retry, absorb, or answer `blocked` with: the fail-fast
  rule of #68. A team never outlives the run's budgets and never wedges.
- **The trace is the team.** Every event carries `agent` and the `delegate`
  call id, so the log and the dashboard render the roster as a tree without a
  second event schema.

Decided, not built, and tracked as "Agent teams" in `ROADMAP.md`. Sailor's side
(which roles exist, what a verifier's verdict gates) is recorded in that repo's
decision #69.

## Decision #72: Reasoning is reported only when the provider produced it

`llm_call_finished` carries `reasoningTokens` whenever the provider sends the
field, and OpenAI-compatible providers send `0` on tool-only turns. Both
projections treated "field present" as "there is reasoning", so every tool-only
turn grew a `Provider reasoning · 0 reasoning tokens` block. In a 45-step run
that is 45 of them, and because the empty block sat between activity groups it
also stopped consecutive single-tool turns from merging; the dashboard read
`1 action performed` / `0 reasoning tokens` on repeat, noise that looked like
the model thinking.

Presence of a number is not evidence of reasoning; a *value* is. The
conversation projection now creates a reasoning part only when there is
reasoning text or tokens greater than zero, and the live projector omits both
empty fields instead of publishing them. The provider's `0` is still recorded
in usage and budgets; it is honest data, just not a block. Sailor's dashboard
applies the same rule to already-persisted traces, so the fix reached the
running UI before the server was restarted. Shipped in 0.1.3. Regressions:
`tests/unit/conversation-projection.test.ts`.

## Decision #73: The tool surface steers to the read-only tools

Decision #69 takes the parallel path only when *every* call in a turn is
read-only, and only `read_file` and `search` declare that flag. The first full
run on that engine (WebRover #19, 45 steps) took the concurrent path exactly
zero times: its vocabulary was `bash`, `read_file`, `edit_file`, `set_phase`,
and every multi-call turn mixed in a shell `grep`/`cat`/`curl`, so `search`
never ran and two reads cost two round trips. The parallelism was not broken.
nothing asked the model for the tools that enable it, and the bash description
actively invited the habit ("Use for git, ls, inspecting the environment,
running scripts, installing packages").

The bash description now says what it is *not* for: "Do not search or read
text with it: use search to find text and read_file to read files: they are
read-only, and several in one turn run together"; this gives the model the reason,
not just the rule. This is a description, not a mechanism: no dispatch,
ordering, or capability changed. Shipped in 0.1.4; Sailor carries the same
steer in its product prompt until it bumps to this version.

## Decision #74: Phase discipline is an intrinsic prompt block, not a footnote

`set_phase` shipped as an advisory label whose own description argued against
it: "it does not authorize actions or require tests… You can finish a response
from any phase without calling this tool." The first full run on that engine
(WebRover #19, 35 steps, cancelled) never called it once: the label stayed
`understand` through thirty-five turns of editing code, so the timeline the
label exists to keep honest was false.

The guidance was not missing, it was quiet: one sentence in the middle of the
strategy prompt, phrased as permission, with the consumer's own sections and
the context blocks stacked after it. Adding a second block in the same place
would inherit all three problems, so the fix is placement and strength, not
volume.

Phases are an engine concept: a strategy declares them and `intrinsics.phase`
registers the tool, so the discipline text is now intrinsic too. The engine
appends `phaseDisciplineBlock(strategy.phases)` to whatever prompt the strategy
produced, exactly as it already appends the revival block, and gates it on the
same `intrinsics.phase` switch that registers the tool: one flag turns both
off. The block is generic on purpose. The engine knows a strategy's phase ids
and nothing about its tools, so it can demand focus and honesty without
assuming that editing code means "act" or that any tool implies a transition.
The tool description and the unknown-phase error no longer argue that the call
is optional, and the coding prompt's own line dropped its
"(it never authorizes or blocks anything)" parenthetical.

This raises the floor for every consumer that uses the default flow. It does
not make the label reliable: prompt-only discipline can still be dropped under
load. If a product needs a guarantee, the lever is a generic, policy-free nudge:
turns since the last phase change, beside `toolOnlyNudge`. That is a product
decision, not an SDK one. Regressions:
`tests/unit/phase-discipline.test.ts`.

## Decision #75: One call is bounded, truncation is not silent

The budgets bound a *run* (steps, tokens, dollars), and the loop detector
bounds *repetition*: the same tool call `repeatLimit` times. Neither bounds a
single response. In the GLM 5.3 round of 2026-10-19 one call in a 35-step task
generated 27,247 tokens over 185.5 seconds, 65% of the task's wall time and 76%
of its output tokens, and ended by narrating its own failure ("I need to stop
the meta-loop"). Time-to-first-token was 0.4s and the prompt was 12k tokens
98% cached: the provider was fast and the context was small. The model simply
kept writing, and nothing in the engine had an opinion about that.

So a per-call output cap now exists, defaulting to
`DEFAULT_MAX_OUTPUT_TOKENS` (12k). It is a parameter on the engine
(`maxOutputTokens`) and a setting a bundle can suggest
(`createCodingAgent({ maxOutputTokens })`), explicit engine options win, the
same precedence `strategy` and `tools` already use, and `false` restores
unbounded output.

The cap is a hard stop, and hard stops have side effects worth naming: a
response chopped mid-thought wastes a step, and because tool calls arrive at
the *end* of a message, a cap that lands first can swallow the tool call
entirely, which looks exactly like a model doing nothing. So truncation is
surfaced rather than inferred: the response carries `finishReason: "length"`
and the engine emits an `output_truncated` advisory. The cap is set generously
for that reason, typical turns in that same run were ~1k tokens, so it bites
only the runaway case.

The second half of that is a correctness rule, not a nicety. The loop accepted
any text-only response as the run's answer, without consulting `finishReason`,
so a reply cut off mid-sentence would have been published as a completed
run: success reported on work the model never finished. A truncated turn that
delivered its tool call is still usable and proceeds normally, and a truncated turn
with no tool call now ends `stalled` with the cap named in the error. A visible
failure is worth more than a plausible-looking partial answer. Regressions:
`tests/unit/max-output-tokens.test.ts`.

## Decision #76: The verbosity nudge is the mirror of the silence nudge

The engine already knows how to prod a model that only acts: after
`toolOnlyNudgeLimit` consecutive tool turns with no visible text, it injects
one advisory asking for a reply or a status. It had nothing for the opposite
model, the one that only writes, which is the state a runaway generation
starts from. In the run that prompted #75, a single turn wrote 108k characters
of prose while the other thirty-four wrote none to 1,784, and no mechanism had
an opinion about the difference.

`guardrails.verboseTurnLimit` (default 8_000) closes the pair: when one turn's
output exceeds the limit, the engine injects one runtime-only advisory: state
the situation in a line, then act, and emits a `verbose_turn` event. It fires
at most once per run, because after the model has been told, repeating it only
adds context, and the output cap is the backstop from then on.

The limit is deliberately below the cap (8k here, 12k of headroom): a nudge
that fires at the same moment as the truncation it exists to prevent would be a
tombstone, not a warning. Both nudges are advisory; they never block an action
or end a run, and both take `false`. Regressions:
`tests/unit/verbose-turn-nudge.test.ts`.

**Amendment (2026-10-20): reasoning is not verbosity.** The first version
compared `completionTokens`, and providers report reasoning inside that number,
so a model thinking hard was told to "stop deliberating in prose" without
having written any. The dial now measures VISIBLE output
(`completionTokens - reasoningTokens`): text and tool-call arguments. A
12k-token turn with 11.5k of reasoning is 500 visible tokens and does not
fire; hidden thinking is legitimate and must never be nudged away.

## Decision #81: The engine delivers background results; the consumer only wakes

Detaching a command is only half a feature. The tool returns "moved to the
background (job X)", and the protocol forbids answering that tool call later,
so the result must arrive as a new runtime input. Consumers had to build that:
Sailor persists a job row, sweeps it with `pollJob`, and turns completion into
an inbox event for the next run. Setting `backgroundAfterSecs` on its own
delivered nothing.

Now the engine owns the ordinary path, for any provider with `pollJob` (Heyo
today):

- it tracks the job handles from the tool results it already emits,
- at every turn boundary it polls them (non-blocking; `undefined` means still
  running) and injects a finished one as `origin: "engine"` — visible to the
  model, never persisted to the thread, never rendered as a user message,
- before a NORMAL finish it waits for what is left, bounded by each job's own
  deadline + grace, because a result that arrives after the run ends is lost
  for this run,
- what still outlives the run is reported on `AgentResult.pendingJobs`, and a
  consumer that woke a new run hands them back as `resumeJobs`.

So "set `backgroundAfterSecs` and nothing else" now works: the agent keeps
working while the command runs, and a job still running when it tries to finish
delays the finish instead of vanishing. The consumer keeps exactly one
responsibility — the clock after the run ends — because only it has a queue.

Docker and E2B do not detach (no `pollJob`), so nothing changes there.
Regressions: `tests/unit/background-exec.test.ts`.

**Amendment (2026-10-20):** three follow-ups from review.

- **Any tool may opt in.** `defineTool(..., { background: true })` records the
  permission; `execPolicy(ctx)` is the single decision (consumer opted in,
  sandbox can poll, command outlives the threshold). `bash` sets it; `run_tests`
  or a future tool can without touching the engine.
- **Polling happens at the turn boundary the model sees.** It runs before every
  model call, after any context fold, so a job (including one carried from a
  prior run) rides the next call instead of costing an extra turn.
- **The result is a fact, not a nudge.** It is stored as `origin: "runtime"`,
  which `conversationHistory` keeps: a resumed run still knows the job finished,
  and a UI may filter it. Nudges stay `origin: "engine"` and are never
  persisted. The body uses the tool truncate-and-spill path, not a private cap.

## Decision #82: The inbox is a store; the chain is the engine's

Every consumer that accepts messages while a run is working writes the same
worker: an abort controller, a wait for the run to settle, a persisted queue, a
dedupe key, a phase to resume at, and a lock so two runs never share a
workspace. Sailor's inbox is that worker. #81 deliberately left the post-run
clock with the consumer "because only it has a queue" — which is true while the
queue is opaque, and false the moment the queue is an interface.

So the queue becomes a store, like `ThreadStore` and `SandboxStore`:

- **`InboxStore`** — `push`, `hasInterject`, `claimAll`, `complete`, `release`.
  `MemoryInboxStore` ships for tests and single-process apps; a product brings
  Postgres.
- **`EngineOptions.inbox`** — `{ store, channel, render? }`. Absent, `runAgent`
  is exactly the single run it always was; nothing in this decision changes an
  existing caller.
- **The chain** — `runAgent` runs one run at a time. When it ends with a normal
  outcome, the engine claims the pending batch and starts the next run with it:
  same thread, same sandbox, same budget. `AgentResult.runs` reports every run.

The delivery split is the whole point:

| delivery | what the engine does |
|---|---|
| `queue` | Leaves the running run untouched. The message becomes part of the next run's task. |
| `interject` | Probes `hasInterject` at each turn boundary and ends the run `interrupted` there — after the completed turn's tool results, never mid-turn where the transcript would be invalid — then claims and starts the next run. |

Consequences and limits, stated so they cannot drift:

- **Ordering is a store contract, not a hint.** A claim returns pending
  interjections newest-first (the latest correction supersedes older ones),
  then queued messages oldest-first. A store that cannot express it cannot
  implement the interface.
- **The batch settles after the run that consumed it.** `complete` on a normal
  ending, `release` on `error`/`cancelled`, so a retry can claim it again. A
  crash between claim and completion is the store's lease problem, not the
  engine's — which is why the interface has `release` at all.
- **One budget for the chain.** An interjection costs time, not a fresh
  allowance. A stream of zero-step interjections is bounded by `maxSteps` runs;
  there is no new public dial.
- **Never claim when the allowance is spent.** The batch stays pending for the
  consumer instead of being completed by a run that can only fail at its first
  boundary.
- **Stop on anything that is not normal** — a pause, a cancel, an error, or an
  exhausted budget — rather than claiming work the caller did not ask for.
- **Background work rides the chain.** A job still running when a run ends is
  carried into the next run as `resumeJobs` automatically, so an interjection
  neither orphans a command nor needs the consumer to hand it back. And when
  inbox work is waiting, a finishing run does not block on its jobs at all: it
  ends, and the next run polls them. That is what the optional
  `InboxStore.hasPending` is for — without it the engine keeps #81's
  wait-before-finish, because ending would lose the result.
- **Two provenances, on purpose.** Background results (#81) are
  `origin: "engine"`: runtime-only, never persisted. Inbox messages are real
  user turns: persisted, displayable, part of `messages`. Do not unify them.
- **No visibility flag.** A message the model sees is a message the trace sees.
  Context is application input, not a secrecy boundary.
- **The consumer keeps the clock only when the chain ends** — per-thread
  locking, classification (which sender may interject), leases, and what to do
  with a batch still pending after a cancel or a spent budget.

`hasInterject` is sampled every turn; an error there is treated as "none", so a
store outage degrades to "no interruption" instead of killing the work. Trace
sinks stay per run, as they always were — a chain is a sequence of runs, not one
fanout with a moving sequence.

Regressions: `tests/unit/inbox.test.ts`.

## Decision #77: The model's own text gets the same boundary as tool output

Tool output has had a size boundary since the spill work: `truncate.ts` keeps a
head and a tail, and saves the full text to scratch so the clipped middle stays
addressable. The assistant's own replies had none. In the run behind #75 a
single turn wrote 108,578 characters, and because every turn re-sends the whole
conversation, that one reply was replayed verbatim on each of the ~29 calls
after it: about 27k tokens per replay, roughly half the run's billed tokens,
and the model re-reading its own essay every time it decided what to do next.
The cap (#75) bounds what one call can *produce*. Nothing bounded what a call
*costs forever after*.

`maxAssistantChars` (default 20_000) is that boundary, and it is applied to the
model's view rather than to the transcript. The loop keeps `messages` whole:
persistence, replay and the event stream all keep every character, and sends a
projected copy built once per turn (`elidedByMessage`, a `WeakMap` keyed by
message identity, so compaction moving messages around cannot desynchronise
it). The omitted middle is spilled to scratch like any other clipped output and
pointed at, so the omission is recoverable rather than final.

A turn cut off by the output cap gets a stricter rule: `truncatedReplyChars`
(default 12_000, `false` to drop the stricter rule) and **head only**, because
a capped reply stops mid-token: the head carries the intent, the tail is a
fragment. Both dials are chars, and the capped budget can only lower the
effective budget, never raise it.

None of this is a substitute for durable state, and it does not need to be: the
sanctioned home for long-lived reasoning is already `.anchor/notes.md`, which
is git-excluded and never elided (#66). Elision bounds the replay of prose the
model has already acted on. Regressions:
`tests/unit/assistant-text-elision.test.ts`.

## Decision #78: A nudge must never be able to end the run

The silent-tool nudge existed to fix a real problem: a reasoning model that
takes tool turn after tool turn without saying anything visible, so nothing it
understood survives a context fold. Its text ended with *"If this request
expects an answer, answer now in text."* That sentence is a sanctioned exit, and
a model that reads it will take it.

On `mwaskom__seaborn-2848` it did. Eight silent tool turns, the nudge fired, the
model replied *"Status update; I reproduced the failure and I'm mid-fix."* with
no tool call, and the loop read it as the run's final answer. Nine steps, no
patch, `completion: "response"`. The bug is not the nudge alone: an ordinary
prose turn is the normal way runs end (four of the eight completed tasks that
round never called `finish`), so the loop cannot tell "I am done" from "I am
still working" by shape.

The fix is a checkpoint, not a ban. A prose-only turn that directly answers an
engine nudge (silent-tool or verbosity) is not accepted as the result: the
engine injects one runtime-only message: call `finish`, continue working, or
repeat the reply, and takes the model's next turn as the answer. One-shot per
run, so it can never become a loop, and it only applies when the agent carries
the intrinsic `finish` tool: without a declared-completion path, prose must stay
a valid exit. `guardrails.proseCheckpoint` (default true) is the off switch.
Both nudges were also reworded to require a next action and to offer no
prose-only exit.

Deliberately scoped to nudge-triggered prose. An earlier version gated every
prose turn after tool work, but that broke nineteen engine tests and would have
added a call to every chat turn that used a tool. The pathology is not "the
model stopped"; it is "the engine asked for something visible and the model
treated the request as permission to finish." That is the turn worth checking.

Regressions: `tests/unit/prose-checkpoint.test.ts`.

## Decision #79: A capped reply continues once, and the run budget is 3M

Sphinx-10325 on the 120-step GLM 5.3 round died at step 62 because one prose
turn hit `maxOutputTokens` (then 12k) with no tool call, and #75 treated that
as `stalled`. The model had been editing and running tests on the previous
twelve turns. The cap did its job: it stopped a 44k-character essay, and
then the engine threw away the run. A chopped sentence must not be published
as the answer. It also must not be the end of a run that was still working.

The first capped prose turn now gets the same treatment as a nudge: one
runtime-only message ("do not rewrite it; next turn must include a tool
call, or call `finish`"), and the loop continues. `pendingProseCheck` is set,
so a following prose reply is the #78 checkpoint rather than an automatic
end. A second capped prose turn in the same run still stalls, so a model that
keeps writing essays cannot loop. `guardrails.proseCheckpoint: false` restores
the old immediate stall. Advisory kind: `output_cap_continue`.

The default cap itself moves from 12k to 16k
(`DEFAULT_MAX_OUTPUT_TOKENS`). The verbosity nudge stays at 8k, still below
the cap, so it can fire before the hard stop on a turn that also called a
tool. `truncatedReplyChars` stays 12k characters: that bounds what is
replayed, not what one call may generate.

The per-run token budget moves from 1.5M to 3M
(`DEFAULT_BUDGET_LIMITS.maxTokens`). Seaborn-2848 on the same round hit
1,517,539/1,500,000 at step 82 with a patch already on disk. The step ceiling
was 120: the token ceiling is what killed it. The eval arm does not pin its
own copy: it calls `runAgent` without `maxOutputTokens` or `maxTokens`, so it
consumes these defaults. A caller can still override both.

Regressions: `tests/unit/max-output-tokens.test.ts`.

## Decision #80: Benchmarks call one API, and say which one served

The GLM 5.3 rounds moved because `z-ai/glm-5.3` on OpenRouter is not one
model. Forty-plus upstreams share the slug, at different prices and
quantizations, and the engine sent no temperature, so each call was a fresh
sample from whichever upstream the router picked. A benchmark of the agent
cannot also be a benchmark of the router.

`--llm parasail` points the eval at Parasail's own API
(`https://api.parasail.io/v1`, key `PARASAIL_API_KEY`, model
`zai-org/GLM-5.3`) and pins `temperature: 0`, `seed: 42`. Those two are
engine options (`sampling`), not new defaults: a product run that does not
set them still leaves sampling to the provider. The OpenRouter key is
untouched. Each `llm_call_finished` now records the `model` the response
named, and `provider` when a gateway sends one, so the next run can prove
what served it instead of inferring from the bill.

Regressions: `tests/unit/llm.test.ts`.

## Decision #83: External effects get a write-ahead operation journal

A run persisted the conversation only after a whole tool batch finished, so a
worker that died between an external write and that save left no trace of the
write in the thread. Recovery read the missing result as "not done" and could
repeat it (a second issue, refund, or message). The trace had intent
(`tool_call`) and observed result (`tool_result`) adjacent, but no record the
harness could read back, and no stable identity the target could use to
recognize a retry.

Tools that change something outside the workspace now declare
`Tool.effect`. The engine then:

1. mints an `operationId` (or uses `effect.key(input)` for a domain key),
2. calls `OperationStore.begin()` — durable — BEFORE the tool runs,
3. passes `context.operationId` to the tool, which forwards it as the target's
   idempotency key, and offers `context.acknowledge()` for acceptance facts,
4. calls `settle()` with the observed outcome — but only AFTER the conversation
   containing that result is durable. A failed thread save leaves the operation
   pending for the next run, rather than settled with no result the model can
   see.

`OperationStore` is the consumer's storage, like `ThreadStore` and
`InboxStore`; `MemoryOperationStore` ships for tests. `EngineOptions.operations`
is opt-in. Without it, effectful tools still run and emit one
`effect_without_journal` advisory — no breaking change, no crash protection.
`MemoryOperationStore` is not crash-durable; production consumers bring a
database (a unique `operation_id` column and an idempotent insert).

On resume, pending operations are reconciled BEFORE the first model call. The
tool's `effect.reconcile()` answers applied / not applied / unknown:

- **applied** → settle as completed and tell the model (runtime message);
- **not applied** → settle as failed; redoing the action is safe;
- **unknown** → stop with `reason: "recovery_required"`, report
  `AgentResult.pendingOperations`, and make NO model call. An ambiguous write
  is never replayed silently.

`ToolResult.completion: "unknown"` marks a result whose effect may have landed
(a lost response, or a failed settle). The trace now records intent
(`tool_call` + `operationId`), acknowledgement (`tool_ack`), observed result
(`tool_result` + `outcome`), and recovery (`reconciled`). Trace sinks remain
best-effort; the operation store is the authoritative record.

The honest guarantee is **effectively-once within the target's idempotency
window**. A target with a unique constraint or idempotency key gets dedupe for
free; a target with a status lookup gets reconciliation; a target with neither
gets a detected unknown, not a duplicate. "Not found" is not treated as "not
applied" unless the tool says so — eventual consistency is the tool's call.

A journal write failure fails closed: a mutating call does not run if its
intent cannot be recorded, and a failed settle marks the result unknown. A
repeated domain key (`effect.key`) is not executed twice: `begin()` returns
false and the call reports that the operation is already recorded.

Regressions: `tests/unit/operation-recovery.test.ts`.

## Decision #84: Reasoning effort is a first-class option

Reasoning budget was implicit: the engine could pin sampling (temperature, seed)
but had no way to say "think harder" or "think less" per run. Every harness that
optimizes long tasks shapes this dial (planning and verification get more
reasoning, the middle gets less), so it belongs in the public surface, not in a
provider-specific wrapper.

`EngineOptions.reasoningEffort` (`minimal` | `low` | `medium` | `high` |
`xhigh` | `max`) travels to every `LLMRequest`; an `Agent.reasoningEffort`
bundle default applies when the run does not set one, and the explicit option
wins. The LLM client sends OpenRouter's `reasoning: { effort }` by default when
the base URL is OpenRouter, and OpenAI's `reasoning_effort` otherwise; a
gateway that speaks the other shape sets `reasoningFormat` explicitly. A
client-level default is also available for consumers that want one effort for
every call.

Ignored by non-reasoning models. No validation beyond the type: providers
reject unsupported levels, and the eval records the chosen level in `run.json`.

Regressions: `tests/unit/llm.test.ts`, `tests/unit/reasoning-effort.test.ts`.
