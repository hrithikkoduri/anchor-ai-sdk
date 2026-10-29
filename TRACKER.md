# Completed work tracker

[`ROADMAP.md`](ROADMAP.md) is the **deferred-work ledger**. This file is the
other half: work that has shipped.

**Rule:** when an item is completed, move it out of `ROADMAP.md` and record it
here. Do not leave the same item in both files. Architectural rationale stays in
[`DECISIONS.md`](DECISIONS.md); release history is in
[`docs/release-status.md`](docs/release-status.md) and the site changelog.

## v0.8.x — released

- [x] v0.8.10 (source): `createBatchTool` — ordered phases of read/search/bash/
      edit/write ops in one call, run through the consumer's own tools, with
      all-or-nothing edits per file, capped output plus a full log, and an
      in-sandbox read/search cache; `search` takes a `glob`.
- [x] v0.8.9: phases off means no phase in the prompt, events, hand-back, or
      thread record; an explicit consumer resume phase is preserved.
- [x] v0.8.8: retained sandboxes are detached, not paused, when a run ends;
      `provider.suspend` owns parking; E2B adoption retries transient workspace
      failures.
- [x] v0.8.7: transient sandbox adoption retries with backoff; `SandboxGoneError`,
      `isSandboxGone`, and `provider.isGone` distinguish gone from transient;
      E2B `configureGit` is idempotent and lock-safe.
- [x] v0.8.6: remove the deprecated `update_ledger` shim; split ledger tools are
      the only contract surface.
- [x] v0.8.5: per-child budgets, soft/hard caps, partial hand-back, steering,
      progress, cancel grace, tool-boundary deadlines, and `worker_stalled`.
- [x] v0.8.3: one tool per ledger operation, with focused schemas.
- [x] v0.8.2: product-neutral repository examples.
- [x] v0.8.1: `extendLedger`, ledger op inference, and unique short-name repo
      resolution.
- [x] v0.8.0: E2B retained-sandbox lifetime renewal and pause-on-timeout; the
      unpublished 0.7.2 delegation-dispatch fix.
- [x] v0.7.1: ledger schema descriptions and retry-shaped errors.

## v0.7.0 — released

- [x] Team admission: `team.admit` checks every delegation before it runs (a
      refusal is the leader's tool result); `delegate` takes the consumer's
      `item` when admission is installed, passed to `workspace` and `meta.item`.
- [x] `scopedSandbox` and `TeamWorkspace.sandbox`: a worker runs in its own tree;
      delegated runs never checkpoint.
- [x] `closeLspSessions(sandbox)`: stop the language servers started for a
      sandbox or view; `warmLspSessions` starts them and loads projects ahead
      of the first call.

## v0.6.0 — released

- [x] Crews: `delegate` worker instances (`worker`, `fresh`, `base`), resumable
      worker memory through `team.sessions` (a ThreadStore), parallel delegation
      to different workers bounded by `team.maxParallel`, and the
      `team.workspace` hook for per-worker working trees.
- [x] Per-delegation live projection with `agent`/`worker`/`role`/`delegateCallId`
      on frames, and `projectConversation` nesting a worker's transcript on the
      leader's `delegate` part.

## v0.5.0 — released

- [x] One-level delegated subagents: named `TeamSpec` roster, `delegate` tool,
      worker/evaluator roles, read-only evaluator enforcement, result-only
      returns, per-member budget caps, and agent-tagged trace events.
- [x] Agent-team docs and public contract exports.
- [x] Consumer-owned team coordination contracts: leased `TeamTaskStore` and
      addressed `AgentMailbox`, with in-memory adapters and lease recovery.
- [x] Contract requirement dependency graph: optional `dependsOn`, custom ids,
      forward references, graph validation, readiness, topological rendering,
      and finish-gate enforcement.
- [x] `CodingPromptOptions.phasesIntro`, and `create_task` raised to 30 atomic
      requirement items.
- [x] Eval harness migrated to the `RunInput` message shape.

## v0.4.0 — released

- [x] Plain-JSON tool-result metadata, ledger evidence, and trace payloads.
- [x] `toPlainJson` / `toPlainJsonObject` boundary normalization.
- [x] Ledger/evidence cycle fixed by returning identifiers from `create_task`.

## v0.3.0 — released

- [x] Skills as progressive disclosure: consumer-owned `SkillProvider`,
      deterministic `renderSkillIndex`, bounded read-only `load_skill`, and
      no sandbox/network/execution coupling.



- [x] Peer-repository workspaces: `RepoRef`, `EngineOptions.repos`,
      repo-aware `bash`/`run_tests`, repo-attributed `edit_file` resources,
      resource-keyed mutation dispatch, per-repo LSP roots, and no-repo
      backward compatibility. Checkpoints remain single-root.

## v0.2.0 — task contracts (released)

- [x] One agent, one input shape: `RunInput`, `userTurn`, and no turn routing,
      `intent`, chat/coding swap, or compile-at-start default.
- [x] Agent-created `create_task` intrinsic with derived request source,
      phase-owned requirements, and dynamic ledger attachment.
- [x] Claimed evidence, `verify` one-call linking, outgoing-phase gates,
      forced transitions after the rejection limit, and honest
      `finish({ success: false })`.
- [x] `Judge` seam using the existing prose verifier (`llmJudge`) with
      per-requirement verdicts and `phase_verdict`/`task_created` events.
- [x] `renderInboxTurn` one-message-per-row input and migrated `RunInput` tests.

## After v0.1.9 — on main, unreleased

- [x] SWE Lite external arm: use `/testbed` for Lite, run pytest from the
      `testbed` conda environment, enforce FAIL_TO_PASS and PASS_TO_PASS, and
      aggregate from `external-results`. One-task-per-model smoke verified
      DeepSeek `1/1` and Qwen `1/1`.
- [x] Generic LSP server definitions: `LspServerConfig` plus `LspServer`, with
      extension-based server selection and per-sandbox/server client caching.
      `TypeScriptLsp` remains the default compatibility preset.
- [x] Python LSP preset: `PythonLsp` / `pythonLanguageServer`, using
      `pyright-langserver --stdio` by default with configurable command and
      initialization options.
- [x] Full common LSP editor surface: hover, completion, signature help,
      highlights, code actions, workspace symbols, formatting/range formatting,
      rename previews, folding ranges, inlay hints, type definitions,
      implementations, and declarations. The default remains the four core tools;
      `features: "all"` / `lspAllTools` opts into all 17.
- [x] Generic `LspServer.request()` escape hatch for standard and
      vendor-specific methods, plus pull-diagnostics support.
- [x] Live validation against real `pyright-langserver` and
      `typescript-language-server` binaries.
- [x] Generic LSP docs, README, and site coverage, including custom stdio
      servers and the image-install boundary.
- [x] Opt-in prompt-cache breakpoints: `promptCache` on the LLM client,
      engine-selected stable-prefix breakpoints, Anthropic-style
      `cache_control` markers, and cached-token cost accounting.
- [x] `createAnchor` composition facade with `run()` and a cheap `doctor()`.
- [x] Exported coding prompt components plus `codingPromptComponents` for
      amendment without copying the default prompt.
- [x] `view_image` tool for text-only agents, with a consumer-supplied vision
      callback and sandbox-side size/MIME checks.

## v0.1.9 — released

- [x] Ledger-aware turn routing: an active required ledger makes `auto`
      follow-ups task turns; explicit `chat`/`clarify`/`task` still wins; inbox
      batches re-route per claimed run.
- [x] Structured task compaction: SDK-owned `CompactionHandoff`, persisted as
      `StoredThread.compaction`; fresh window with pinned task/ledger + handoff
      + recent verbatim tail. Chat keeps the legacy prose summary path.
- [x] Image context: `ImageAttachment` on runs, user messages, and inbox
      messages; OpenAI-compatible `image_url` serialization. Consumer owns
      upload, bytes, validation, signed URLs, retention, and traces.
- [x] E2B preview ports: `Sandbox.exposePort()` with explicit `previewPort`
      capability. E2B returns a public HTTPS URL; other providers declare false.
- [x] Consumer-store documentation: Postgres examples for thread, inbox,
      operation, and sandbox stores, plus compaction handoff.
- [x] Site release history and the complete v0.1.7 benchmark page.

## v0.1.8

- [x] Opt-in verifier mode: append-only ledger, structured compiler, evidence
      capture, intent routing, phase/finish gates, and thread persistence.
- [x] `completeStructured()` / `responseFormat` structured output.
- [x] External-effect operation recovery with durable begin/settle and
      reconciliation.
- [x] Terminal-native agent bundle.
- [x] Bounded consumer tool results.
- [x] Persistent process streams for Local, Docker, E2B, and Heyo.
- [x] Common `ImagePublisher` contract and `anchor image publish` for Docker,
      E2B, and Heyo.
- [x] Optional `anchor-ai-sdk/lsp`: TypeScript/JavaScript diagnostics,
      definition, references, symbols.

## v0.1.7

- [x] Background-result delivery at turn boundaries.
- [x] Inbox store and run-chain primitives.
- [x] Docker `egress: "none"` after setup.
- [x] Visible-output verbosity accounting; dispatch/guardrail split.
- [x] Build-first README, examples, and site refresh.

## v0.1.6

- [x] E2B sandbox adapter with templates, adoption, checkpoints, and offline
      tests.
- [x] Per-call output caps, assistant-text elision, and bounded course
      correction for empty/repeated turns.
- [x] E2B credential mint reuse; eval environment and template guidance.

## v0.1.5

- [x] Phase discipline as an intrinsic prompt block.
- [x] Sandbox image-source and boot-cost documentation.

## v0.1.4

- [x] Shell guidance points reads to `read_file` and searches to `search`.
- [x] Decision records for the read-only tool boundary and agent-team design.

## v0.1.3

- [x] `backgroundAfterSecs`, background job handles, `pollJob`, `killJob` for
      Heyo.
- [x] `background_started` event carries job lifetime.
- [x] Zero reasoning tokens are not treated as a reasoning block.

## v0.1.2

- [x] Heyo guest-job registry; lost receipts fail one command instead of
      wedging the sandbox.
- [x] Concurrent read-only execution.
- [x] Per-benchmark eval folders.

## v0.1.1

- [x] Prompt nudge to call `set_phase` at real transitions.
- [x] Runnable quickstart and non-coding examples.
- [x] README accuracy work, CI fixes, and the first site.

## v0.1.0

- [x] Initial standalone agent-harness package: loop, tools, budgets,
      guardrails, compaction, thread persistence, pause/resume, and evidence.
- [x] `SandboxProvider` seam with Local, Docker, and Heyo adapters, git
      checkpoints, retention/adoption, credential callback, and conformance.
- [x] Revival planning, trace sinks, and repository-owned evals.

## Release verification

The current release-candidate checks are recorded in
[`docs/release-status.md`](docs/release-status.md). Update this file whenever a
deferred roadmap item ships.
