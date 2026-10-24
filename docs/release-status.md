# Release status and roadmap snapshot

Status: **2026-10-23**, v0.3.1 released: npm `0.3.1`, Git tag `v0.3.1`, and GitHub Release are published.

This is the short, current view. Completed work is in [`TRACKER.md`](../TRACKER.md);
the canonical deferred-work ledger is [`ROADMAP.md`](../ROADMAP.md); architectural
decisions are in [`DECISIONS.md`](../DECISIONS.md); the ranked harness assessment
is in [`docs/harness-assessment-2026-10.md`](harness-assessment-2026-10.md).

## Released

**v0.3.1** is the current npm/tag release. Its release notes are on
[GitHub Releases](https://github.com/hrithikkoduri/anchor-ai-sdk/releases).

### v0.3.1 contents

- `ToolResult.meta` is plain `JsonObject`; every result is copied to detached
  JSON before trace/evidence/journal use.
- `toPlainJson`/`toPlainJsonObject` normalize cycles, BigInts, functions, Dates,
  Maps, Sets, Errors, and class instances at the boundary.
- `create_task` no longer returns the live ledger in result meta, fixing the
  ledger/evidence cycle that broke JSON persistence.
- Trace redaction now operates on the serializable copy.

Verification for v0.3.1: `npm run typecheck`, `npm test` (396 passed, 23
skipped), `npm run build`, and dist-export verification.

### v0.3.0 contents

- Peer-repository workspaces: `RepoRef`/`EngineOptions.repos`, one-call-per-repo
  `bash` and `run_tests`, repo-attributed `edit_file`, resource-keyed mutation
  dispatch, per-repo LSP roots, and unchanged single-root checkpoints. No-repo
  behavior is unchanged.
- Skills as progressive disclosure: consumer-owned `SkillProvider`, deterministic
  `renderSkillIndex`, and a bounded read-only `load_skill` tool. Bodies are tool
  results, never system instructions; scripts still use `bash`.

Verification for v0.3.0: `npm run typecheck`, `npm test` (390 passed, 23
skipped), `npm run build`, dist-export verification, and the site build.

### v0.2.0 contents

- One agent and one input shape. `RunTask` is gone; `runAgent(input: RunInput, opts)`
  takes a message delta. Turn routing, `intent`, the chat-agent swap, and
  compile-at-start are removed.
- `create_task` is an engine intrinsic. The agent creates the contract mid-run;
  the engine derives the request source from user messages, attaches the ledger,
  registers `update_ledger`, and arms phase/finish gates. `create: "start"` is the
  only compile-at-start path.
- Requirements own phases; `set_phase` judges the outgoing phase. Evidence links
  require a claim; `op: "verify"` links and verifies in one call. Rejections name
  unmet requirements and probabilities; after the limit, transition is forced
  but finish stays gated.
- Judge seam: `Judge` in `src/verify/judge.ts`, with `llmJudge` adapting the
  existing prose verifier to per-requirement verdicts. `VerifierConfig.llm`
  remains sugar for `llmJudge`.
- `finish({ success: false })` ends `ok: false` with `reason: "finished"` and
  records open requirements as failures.
- `renderInboxTurn` keeps one user message per inbox row. `run_started` carries
  `{ text, messages?, phases }`; `task_created` and `phase_verdict` events are
  emitted.

### v0.1.9 contents

- Ledger-aware turn routing: active ledger keeps `auto` follow-ups on the task
  path; explicit intent still wins; inbox batches re-route per run.
- Structured task compaction: SDK-owned `CompactionHandoff`, persisted as
  `StoredThread.compaction`; fresh window with pinned ledger/handoff plus a
  recent verbatim tail. Chat keeps the legacy prose summary path.
- Image context: `ImageAttachment` on run inputs, user messages, and inbox
  messages; OpenAI-compatible `image_url` serialization. Bytes, upload,
  validation, signed URLs, and retention remain consumer responsibilities.
- E2B preview ports: `Sandbox.exposePort(port)` and `previewPort` capability;
  E2B returns a public HTTPS URL. Other providers declare `false`.
- Consumer docs: Postgres implementations for thread, inbox, operation, and
  sandbox stores, plus compaction handoff.
- Site: release timeline, per-tag GitHub release notes, and the complete v0.1.7
  benchmark record.

## Earlier post-v0.1.9 work included in v0.2.0

- Generic LSP server definitions: `LspServerConfig` plus `LspServer`, with
  extension-based selection and per-sandbox/server client caching.
  `TypeScriptLsp` remains the default compatibility preset.
- Python LSP preset: `PythonLsp` / `pythonLanguageServer`, defaulting to
  `pyright-langserver --stdio` and accepting a different command and
  initialization options.
- Full common LSP editor surface: hover, completion, signature help,
  highlights, code actions, workspace symbols, formatting/range formatting,
  rename previews, folding ranges, inlay hints, and type/implementation/
  declaration navigation. Core remains the default; `features: "all"` enables
  all 17 tools. `LspServer.request()` covers other methods.
- Opt-in prompt caching: `promptCache` on the LLM client, engine-selected
  stable-prefix breakpoints, Anthropic-style `cache_control` markers, and
  cached-token cost accounting. The turn-scoped ledger/phase block is never
  marked. See [`docs/prompt-caching.md`](prompt-caching.md).
- `createAnchor` composition facade: captures the LLM/agent/sandbox/thread and
  returns `{ run, doctor }`; per-run options still go through `runAgent`.
- Exported coding prompt components (`character`, `tone`, `judgment`,
  `operatingRules`, `verification`) plus `codingPromptComponents`.
- `view_image` tool: reads sandbox image bytes and delegates the vision step to
  a consumer callback, with MIME/size checks.
- SWE Lite external arm: use `/testbed`, run pytest from the `testbed` conda
  environment, enforce FAIL_TO_PASS and PASS_TO_PASS, and aggregate from
  `external-results`. Smoke: DeepSeek `1/1`, Qwen `1/1` on one task each.

Verification after the LSP, prompt-cache, and composition changes:
`npm run typecheck`, `npm test` (373 passed, 23 skipped), `npm run build`, live
pyright + TypeScript smoke, `site` build, and the site browser suite (42
passed). No new benchmark result is claimed.

## v0.3.1 release checklist

1. [x] Bump `package.json` to `0.3.1` (package-lock updated).
2. [x] Add the v0.3.1 entry to `site/src/releases.json`.
3. [x] Create the GitHub Release at the v0.3.1 tag.
4. [x] Re-run typecheck, full tests, build, dist-export verification, and site build.
5. [x] Publish npm `0.3.1`.
6. No v0.3.1 benchmark result is claimed. The only recorded complete benchmark
   is `evals/results/v0.1.7-2fbc92b/`.

## Deferred list

### Sandbox

- Daytona adapter
- Egress allowlists
- Artifact → git fallback chain
- Remote-provider `fork()`
- Heyo ports/routes
- Daytona image publishing
- Live image-registry conformance

### Runtime / reliability

- Baseline-relative suite evidence
- Abortable one-shot `exec`
- Rerun the full SWE Lite external matrix on the next release commit

### Models / multimodal

- Per-phase model and reasoning routing
- Native Anthropic / Gemini adapters, including native image blocks
- PDF/audio/video preprocessing or native file input
- Vercel AI-SDK bridge

### Agent capabilities

- Skills / lazy tool disclosure
- MCP with lazy discovery
- Single evaluator subagent
- Full parallel tool calls for mutations
- Agent teams

### Observability

- OTel trace sink
- LangSmith adapter
- Braintrust adapter

## Small wins after v0.1.9

These are deliberately post-release to keep the v0.1.9 surface stable:

- LangSmith and Braintrust adapters (S)
- Native Anthropic/Gemini image blocks (M)
- Daytona image publisher once the adapter exists (S)
- Live registry conformance for published images (M)
