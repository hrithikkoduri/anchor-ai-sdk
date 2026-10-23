# Completed work tracker

[`ROADMAP.md`](ROADMAP.md) is the **deferred-work ledger**. This file is the
other half: work that has shipped.

**Rule:** when an item is completed, move it out of `ROADMAP.md` and record it
here. Do not leave the same item in both files. Architectural rationale stays in
[`DECISIONS.md`](DECISIONS.md); release history is in
[`docs/release-status.md`](docs/release-status.md) and the site changelog.

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
