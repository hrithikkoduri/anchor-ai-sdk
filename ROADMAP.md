# ROADMAP.md — deferred work (the contributor ledger)

Everything here is a decision already made and work intentionally not built
yet. Each item names the event that pulls it back ("trigger"), where it lives,
and its rough size, so anyone can pick one up without reading the whole
history. **Product-side work lives in the Sailor repo's `ROADMAP.md`.**

**How to pick one up**

1. Open an issue naming the item (one item per PR keeps review small).
2. The rule that keeps the boundary honest: **mechanics here, policy in the
   consumer** — and this package never reads configuration (options in,
   nothing touches `process.env`); the guard suite enforces it.
3. Gate every change with `npm run typecheck && npm test` — CI runs the same,
   plus Docker conformance; live microVM tests are opt-in.
4. When an item ships: delete it here and record the decision in
   `DECISIONS.md`.

## Tracing & observability

- **OTel trace sink** — translate `AgentEvent`s into OTLP spans; one adapter
  reaches Langfuse / Honeycomb / Datadog / Grafana. The `traceSinks` fan-out
  and the one-sequence-number contract already exist. _Where:_ `src/trace/`,
  as a companion package over `TraceSink`. _Trigger:_ wanting hosted traces.
  _Size:_ S–M.
- **LangSmith adapter** — map run/step/tool events to LangSmith runs + spans.
  _Where:_ a companion package over `TraceSink`. _Trigger:_ actively using
  LangSmith. _Size:_ S.
- **Braintrust adapter (tracing + evals)** — the same stream also builds eval
  records. _Where:_ a companion package over `TraceSink`. _Trigger:_ actively
  using Braintrust. _Size:_ S.
- **Export tool-author helpers** — `requireString`, `optionalString`,
  `requireSandbox`, `formatExec` are internal to `src/tools/types.ts`.
  _Where:_ export them from `src/tools/index.ts`. _Trigger:_ the next tool
  authored outside the package. _Size:_ XS — good first issue.

## Sandbox providers

- **E2B adapter** — implement the provider contract (exec, clone, checkpoint,
  retain) and pass `runSandboxConformance`. A stub module exists in-repo
  (`src/sandbox/e2b/`) but is **not exported** until the suite passes.
  _Trigger:_ a second VM vendor is needed (region, cost, comparison).
  _Size:_ M.
- **Daytona adapter** — same shape as E2B (`src/sandbox/daytona/`). _Trigger:_
  same. _Size:_ M.
- **Egress control enforcement** — the capability flag exists; enforcement
  (per-VM allowlists) waits for a provider that supports it. _Where:_
  `src/sandbox/`. _Trigger:_ a consumer needs network restriction. _Size:_ M.
- **Artifact→git image fallback chain** — try the primary image source; on
  job failure, destroy and recreate from the secondary. Widen the
  build-secret refresh condition to "git anywhere in the chain". _Where:_
  `src/sandbox/heyo/index.ts` `start()`. _Trigger:_ artifact kind primary in
  production **and** store flakiness on pulls. _Size:_ S–M.
- **Publish the ext4 + flip `HEYO_IMAGE_KIND=artifact`** — blocked
  externally: Heyo's namespace artifact store rejects uploads (`Broken pipe`
  at 1 GiB, `502` at 64 MiB, `setRepo` 502). The rootfs is built and verified
  locally (the Sailor repo's `image/`). _Trigger:_ the store heals → one
  `heyctl artifact push rootfs.ext4 --tag <your-namespace>/toolchain:latest`
  plus the env flip. _Size:_ S (blocked externally).
- **`fork()` (checkpoint → new VM)** — start a second sandbox from a
  checkpoint for best-of-N races; `local` already implements it (the
  conformance suite caught the capability lie once). _Where:_ `src/sandbox/`.
  _Trigger:_ best-of-N work starts. _Size:_ M.
- **Ports/routes for non-coding sandboxes** — `HeyoSandbox` hardcodes
  `routes: []` (private: exec/shell only). A consumer running a dev server or
  a browser task needs exposed ports/preview routes on the deployment spec.
  _Where:_ `src/sandbox/heyo/index.ts` (`HeyoSandboxConfig.routes`, health
  port). _Trigger:_ the first non-coding consumer needing HTTP. _Size:_ S–M.

## Run pipeline

- **Git-credential callback** — replace the one-shot `githubToken` with
  `git: { token: () => Promise<string> }` so providers re-resolve credentials
  per clone/push (installation tokens live an hour; longer runs silently push
  with stale credentials) and the credential host stops being hardcoded to
  `github.com`. _Where:_ `src/sandbox/types.ts` + adapters (Sailor already
  passes the callback). _Trigger:_ none — correctness fix, ready now.
  _Size:_ S–M.
- **`createAnchor` facade** — ~20 lines of sugar over the run-pipeline calls
  (captures llm/provider/stores, returns `{ run, doctor }`). _Trigger:_ a
  second consumer wants the same wiring bundle (the eval CLI is the likely
  first). _Size:_ XS once the items above land.
- **Baseline-relative suite evidence** — FAIL_TO_PASS / PASS_TO_PASS deltas:
  `run_tests` gains `junit_path` → `meta.tests` (JUnit XML parse); success =
  no baseline-passing test regresses. _Where:_ `src/tools/run-tests.ts` plus
  the eval task JSON under `evals/data/`. _Trigger:_ evals on real repos whose
  `main` is not green. _Size:_ M.

## Model providers

- **Native Anthropic / Gemini adapters** — first-class clients (not the
  OpenAI-compat shim), including **opaque reasoning replay** (carry signed
  reasoning blocks across turns). _Where:_ `src/llm/`. _Trigger:_ actually
  running those models. _Size:_ M / S.
- **`cache_control` markers** — for providers that require explicit cache
  breakpoints. _Where:_ `src/llm/`. _Trigger:_ an opt-in-caching provider is
  used. _Size:_ XS.
- **Vercel AI-SDK bridge** — an adapter over `LLMClient`. _Trigger:_ a third
  ecosystem asks. _Size:_ M.

## In flight (work, not deferred)

- The benchmark rounds run from `evals/`: Opus 5.5 on Lite-10 (budgets
  capped), then TerminalBench / METR / ProgramBench as `benchmarks/<name>/`.
