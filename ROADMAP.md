# ROADMAP.md: deferred work (the contributor ledger)

Everything here is a decision already made and work intentionally not built
yet. Each item names the event that pulls it back ("trigger"), where it lives,
and its rough size, so anyone can pick one up without reading the whole
history. **Product-side work lives in the Sailor repo's `ROADMAP.md`.**

**How to pick one up**

1. Open an issue naming the item (one item per PR keeps review small).
2. The rule that keeps the boundary honest: **mechanics here, policy in the
   consumer**, and this package never reads configuration (options in,
   nothing touches `process.env`); the guard suite enforces it.
3. Gate every change with `npm run typecheck && npm test`; CI runs the same,
   plus Docker conformance; live microVM tests are opt-in.
4. When an item ships: delete it here and record the decision in
   `DECISIONS.md`.

## Tracing & observability

- **OTel trace sink**: translate `AgentEvent`s into OTLP spans: one adapter
  reaches Langfuse / Honeycomb / Datadog / Grafana. The `traceSinks` fan-out
  and the one-sequence-number contract already exist. _Where:_ `src/trace/`,
  as a companion package over `TraceSink`. _Trigger:_ wanting hosted traces.
  _Size:_ S–M.
- **LangSmith adapter**: map run/step/tool events to LangSmith runs + spans.
  _Where:_ a companion package over `TraceSink`. _Trigger:_ actively using
  LangSmith. _Size:_ S.
- **Braintrust adapter (tracing + evals)**: the same stream also builds eval
  records. _Where:_ a companion package over `TraceSink`. _Trigger:_ actively
  using Braintrust. _Size:_ S.
- **Export tool-author helpers**: `requireString`, `optionalString`,
  `requireSandbox`, `formatExec` are internal to `src/tools/types.ts`.
  _Where:_ export them from `src/tools/index.ts`. _Trigger:_ the next tool
  authored outside the package. _Size:_ XS, good first issue.

## Sandbox providers

- **E2B adapter**: implement the provider contract (exec, clone, checkpoint,
  retain) and pass `runSandboxConformance`. A stub module exists in-repo
  (`src/sandbox/e2b/`) but is **not exported** until the suite passes.
  _Trigger:_ a second VM vendor is needed (region, cost, comparison).
  _Size:_ M.
- **Daytona fork/best-of-N**: the adapter ships (`src/sandbox/daytona/`) but
  declares `fork: false` — the API rejects forking of container-class
  sandboxes, so racing needs a rebuild-from-checkpoint path instead of a native
  fork. _Where:_ `src/sandbox/daytona/index.ts`. _Trigger:_ a best-of-N run on
  Daytona. _Size:_ M.
- **Daytona process streams**: `openProcess()` is omitted because a session
  command has no stdin EOF and the PTY is an interactive shell. A real fix
  needs a session variant with a proper close, or a guest-side FIFO supervisor
  like Heyo's. _Where:_ `src/sandbox/daytona/`. _Trigger:_ an LSP/REPL over
  Daytona. _Size:_ M.
- **Daytona image publishing**: snapshot creation is reachable
  (`daytona.snapshot.create`) but needs an account tier that grants it; wiring
  it to `ImagePublisher` is the remaining seam. _Size:_ S.
- **Egress allowlists**: Docker now enforces `egress: "none"` (disconnect
  after setup) and declares the capability; the eval exposes `--egress none`.
  Missing is the middle setting, allow only a package index or a host list,
  which needs a proxy or rules inside the container. _Where:_
  `src/sandbox/docker/index.ts`. _Trigger:_ a task needs `pip install` during
  the agent phase. _Size:_ M.
- **Artifact→git image fallback chain**: try the primary image source; on
  job failure, destroy and recreate from the secondary. Widen the
  build-secret refresh condition to "git anywhere in the chain". _Where:_
  `src/sandbox/heyo/index.ts` `start()`. _Trigger:_ a store outage in
  production. Not triggered by a broken store: a 4 GiB ext4 pushed and booted
  on 2026-10-20 (`harness/sailor-toolchain:latest`, public) and the reference
  deployment runs `HEYO_IMAGE_KIND=artifact`, boot 125.6s vs 207s for git.
  _Size:_ S–M.
- **`fork()` (checkpoint → new VM)**: start a second sandbox from a
  checkpoint for best-of-N races; `local` already implements it (the
  conformance suite caught the capability lie once). _Where:_ `src/sandbox/`.
  _Trigger:_ best-of-N work starts. _Size:_ M.
- **Ports/routes for non-coding sandboxes**: `HeyoSandbox` hardcodes
  `routes: []` (private: exec/shell only). A consumer running a dev server or
  a browser task needs exposed ports/preview routes on the deployment spec.
  _Where:_ `src/sandbox/heyo/index.ts` (`HeyoSandboxConfig.routes`, health
  port). _Trigger:_ the first non-coding consumer needing HTTP. _Size:_ S–M.

## Run pipeline

- **Git-credential callback**: replace the one-shot `githubToken` with
  `git: { token: () => Promise<string> }` so providers re-resolve credentials
  per clone/push (installation tokens live an hour; longer runs silently push
  with stale credentials) and the credential host stops being hardcoded to
  `github.com`. _Where:_ `src/sandbox/types.ts` + adapters (Sailor already
  passes the callback). _Trigger:_ none; correctness fix, ready now.
  _Size:_ S–M.
- **`createAnchor` facade**: ~20 lines of sugar over the run-pipeline calls
  (captures llm/provider/stores, returns `{ run, doctor }`). _Trigger:_ a
  second consumer wants the same wiring bundle (the eval CLI is the likely
  first). _Size:_ XS once the items above land.
- **Baseline-relative suite evidence**: FAIL_TO_PASS / PASS_TO_PASS deltas:
  `run_tests` gains `junit_path` → `meta.tests` (JUnit XML parse); success =
  no baseline-passing test regresses. _Where:_ `src/tools/run-tests.ts` plus
  the eval task JSON under `evals/benchmarks/swe-bench/data/`. _Trigger:_ evals on real repos whose
  `main` is not green. _Size:_ M.

## Model providers

- **Native Anthropic / Gemini adapters**: first-class clients (not the
  OpenAI-compat shim), including **opaque reasoning replay** (carry signed
  reasoning blocks across turns). _Where:_ `src/llm/`. _Trigger:_ actually
  running those models. _Size:_ M / S.
- **`cache_control` markers**: for providers that require explicit cache
  breakpoints. _Where:_ `src/llm/`. _Trigger:_ an opt-in-caching provider is
  used. _Size:_ XS.
- **Vercel AI-SDK bridge**: an adapter over `LLMClient`. _Trigger:_ a third
  ecosystem asks. _Size:_ M.

## Agent capabilities

- **Skills (load into the sandbox)**: a consumer ships skill bundles (a
  `SKILL.md` + assets/scripts); the SDK materializes them into a reserved
  sandbox directory (`.anchor/skills/<name>/`, git-excluded like notes),
  lists them in the prompt with a read-first contract, and the agent invokes
  them through its existing tools: mechanics here, content stays
  consumer-owned. _Where:_ `src/agents/` (prompt section) +
  `src/sandbox/` (materialization) + the option types in `src/engine/`.
  _Trigger:_ the first consumer with skills to load (Sailor is the likely
  first). _Size:_ M.

- **Parallel tool calls (full)**: read-only calls from one turn already
  dispatch concurrently (decision #69). Concurrent mutations are deferred:
  they need per-tool concurrency metadata plus isolation/ordering guarantees
  the single-flight sandbox gate deliberately avoids. _Size:_ L.

- **Agent teams (lead + teammates)**: today a run is one `Agent`, one loop,
  one conversation. Teams let the consumer declare a roster (`lead` +
  teammates, each with its own prompt, tool subset, and budget share) and have
  the engine inject a `delegate` tool into the lead: calling it runs the named
  teammate as a **nested engine loop in the same sandbox** and returns only the
  teammate's final text as the tool result; its transcript stays in the trace,
  not in the lead's context. Depth is capped at 1 unless the consumer opts into
  deeper teams with an explicit cap, and only the lead may `finish()`.
  Delegated usage charges the run's single budget (per-teammate caps return a
  structured failure); mutations keep the single-flight sandbox gate, with
  concurrent read-only teammates as a later step over decision #69. Every event
  gains `agent` + the `delegate` call id so the trace renders the team as a
  tree, and a teammate failure comes back as a tool result the lead can retry,
  absorb, or turn into a `blocked` finish, never a wedged run (the fail-fast
  rule of #68). Which roles exist, their tools, and the split stay
  consumer-owned. _Where:_ `src/engine/` (delegate tool + nesting), `src/agents/`
  (team spec + prompt), `src/trace/` (agent-tagged events). _Trigger:_ the first
  consumer wanting specialization (a verifier or investigator teammate);
  Sailor's verifier is the likely first. _Size:_ L.

- **Export the prompt components**: `buildCodingPrompt` and
  `CodingPromptOptions` are public, but the default section strings
  (`character`, `tone`, `judgment`, `operatingRules`, `verification`) are not,
  and the `exports` map blocks deep imports. A product that wants to *amend*
  one rule, rather than replace a whole section, must either copy the text
  (silent drift) or interpret it from an additional section (what Sailor did
  for issue-fix scope, its decision #70). Export the components so consumers
  compose them. _Where:_ `src/agents/coding/prompts/` +
  `src/agents/coding/index.ts`. _Trigger:_ the first consumer amending a rule
  (Sailor, now). _Size:_ S.

## In flight (work, not deferred)

- **Phase discipline is intrinsic** (decision #74, 2026-10-19): the engine
  appends `phaseDisciplineBlock(strategy.phases)` after the strategy prompt,
  gated on the same `intrinsics.phase` flag that registers the tool, and the
  `set_phase` description no longer argues that its own call is optional.
- **Background long commands landed** (decision #70, 2026-10-19):
  `ExecOptions.backgroundAfterSecs`, `ExecResult.background`, `pollJob`/
  `killJob`, the `background_started` engine event, and Sailor's
  `background_jobs` + worker sweep. Trigger was the WebRover #19 wedge.
- The benchmark rounds run from `evals/benchmarks/swe-bench/`: Opus 5.5 on Lite-10 (budgets
  capped), then TerminalBench / METR / ProgramBench as `benchmarks/<name>/`.
