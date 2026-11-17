# Documentation

The SDK README is the main guide. These pages go deeper on the seams that
consumers own.

| Topic | Page |
| --- | --- |
| Task contracts and the ledger | [task-contracts.md](task-contracts.md) |
| Agent teams, budgets, and steering | [agent-teams.md](agent-teams.md) |
| Thread checkpoints and durable logs | [checkpoints.md](checkpoints.md) |
| Inbox deliveries and steer | [inbox.md](inbox.md) |
| Reasoning and tool-call guardrails | [reasoning.md](reasoning.md) |
| Composition helpers | [composition.md](composition.md) |
| Skills | [skills.md](skills.md) |
| LSP tools | [lsp.md](lsp.md) |
| Prompt caching | [prompt-caching.md](prompt-caching.md) |
| Sandbox image publishing | [sandbox-image-publishing.md](sandbox-image-publishing.md) |
| Heyo provider notes | [heyo-provider-notes.md](heyo-provider-notes.md) |
| Harness assessment | [harness-assessment-2026-10.md](harness-assessment-2026-10.md) |
| Release status | [release-status.md](release-status.md) |

## Release notes

Release history lives in [release-status.md](release-status.md) and the
site changelog. The site timeline and GitHub release bodies share
[`site/src/releases.json`](../site/src/releases.json).

## Keeping the docs honest

- The code is the source of truth. If a page and the code disagree, fix the
  page in the same change.
- Use the current `RunInput` message shape: `runAgent({ messages: [...] }, opts)`.
  Do not use the removed `RunTask`/`task` shape.
- The ledger is the task contract. The task board is not a second ledger.
- Do not present a task-local event as durable org knowledge.
