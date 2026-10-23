# Release status and roadmap snapshot

Status: **2026-10-23**, preparing **v0.1.9**.

This is the short, current view. The canonical deferred-work ledger is
[`ROADMAP.md`](../ROADMAP.md); architectural decisions are in
[`DECISIONS.md`](../DECISIONS.md); the ranked harness assessment is in
[`docs/harness-assessment-2026-10.md`](harness-assessment-2026-10.md).

## Released

**v0.1.8** is the current npm/tag release. Its release notes are on
[GitHub Releases](https://github.com/hrithikkoduri/anchor-ai-sdk/releases).

## On main for v0.1.9 — release candidate

- Ledger-aware turn routing: active ledger keeps `auto` follow-ups on the task
  path; explicit intent still wins; inbox batches re-route per run.
- Structured task compaction: SDK-owned `CompactionHandoff`, persisted as
  `StoredThread.compaction`; fresh window with pinned ledger/handoff plus a
  recent verbatim tail. Chat keeps the legacy prose summary path.
- Image context: `ImageAttachment` on `RunTask`, user messages, and inbox
  messages; OpenAI-compatible `image_url` serialization. Bytes, upload,
  validation, signed URLs, and retention remain consumer responsibilities.
- E2B preview ports: `Sandbox.exposePort(port)` and `previewPort` capability;
  E2B returns a public HTTPS URL. Other providers declare `false`.
- Consumer docs: Postgres implementations for thread, inbox, operation, and
  sandbox stores, plus compaction handoff.
- Site: release timeline, per-tag GitHub release notes, and the complete v0.1.7
  benchmark record.

Verification at this snapshot: `npm run typecheck`, `npm test` (360 passed,
23 skipped), `npm run build`, and the site browser suite (42 passed).

## Release checklist

1. Bump `package.json` to `0.1.9`.
2. Add the v0.1.9 entry to `site/src/releases.json`.
3. Create the GitHub Release at the v0.1.9 tag.
4. Re-run typecheck, full tests, build, and site build.
5. Publish npm only on explicit authorization.
6. Do not label any v0.1.8/v0.1.9 benchmark as a result. The only recorded
   complete benchmark is `evals/results/v0.1.7-2fbc92b/`.

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

- `createAnchor` facade
- Baseline-relative suite evidence
- Abortable one-shot `exec`
- Fix the SWE Lite external benchmark arm and rerun the full matrix

### Models / multimodal

- Per-phase model and reasoning routing
- Native Anthropic / Gemini adapters, including native image blocks
- PDF/audio/video preprocessing or native file input
- `cache_control` markers
- Vercel AI-SDK bridge

### Agent capabilities

- Skills / lazy tool disclosure
- MCP with lazy discovery
- Single evaluator subagent
- Full parallel tool calls for mutations
- Agent teams
- Export prompt components

### Observability

- OTel trace sink
- LangSmith adapter
- Braintrust adapter

## Small wins after v0.1.9

These are deliberately post-release to keep the v0.1.9 surface stable:

- `createAnchor` facade (XS)
- `cache_control` markers (XS)
- Export prompt components (S)
- LangSmith and Braintrust adapters (S)
- `view_image` tool for text-only models (S–M)
- Native Anthropic/Gemini image blocks (M)
- Daytona image publisher once the adapter exists (S)
- Live registry conformance for published images (M)
