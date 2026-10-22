# Anchor harness assessment — October 2026

Purpose: decide what to build next by looking at what actually moves agent
performance, not what sounds sophisticated. Anchor has a sound loop, sandbox,
recovery, and observability. This memo asks where the remaining ceiling is.

**The short version**

1. On frontier models, the harness is worth **roughly 7–15 points** on identical
   weights, and **up to 18–24 points** across harnesses on the same benchmark.
   The spread between frontier models under one scaffold is often **under 5
   points**.
2. Most failures are execution failures, not reasoning failures: tool
   recovery, evidence grounding, state continuation, and verification. One
   benchmark attributes roughly **two-thirds** of failures to the harness layer.
3. Long-horizon tasks fail mostly by **timeout after partial progress** (79%)
   and **premature "done"** (19%), not by local wrong actions.
4. The highest-leverage missing primitives in Anchor are: a **progress ledger
   with a verification gate**, **context reset with a durable handoff**,
   **skills/tool disclosure**, and **an evaluator separated from the
   generator**.
5. Graph memory is not the next unlock for coding agents. Filesystem + git +
   a project knowledge map is the consensus; graph memory helps multi-hop
   recall, not repository state.

---

## 1. The evidence that the harness is the product

### Same model, different wrapper

| Comparison | Score with wrapper A | Score with wrapper B | Delta |
|---|---|---|---|
| Claude Opus 4.5, SWE-bench Pro | 45.9% (SEAL scaffold) | 55.4% (Claude Code) | **+9.5** |
| GPT-5.2-Codex, Terminal-Bench 2.0 | 57.5% (Terminus-2) | 64.7% (Codex CLI) | **+7.2** |
| Claude Opus 4.6, Terminal-Bench 2.0 | 76.4% (best harness) | 58.0% (worst harness) | **18.4 span** |
| GPT-5.3-Codex, Terminal-Bench 2.0 | best | worst | **15.5 span** |
| Six frontier models, one SEAL scaffold, SWE-bench Pro | 41.0% | 45.9% | **4.9 model span** |

The wrapper is worth more than the gap between the best and worst frontier
model in the same frame. Two consequences:

- A benchmark result without the harness named is incomplete.
- Our own eval records must always include harness version, model, budget,
  tokens, and cost.

Sources: Zhang et al., *Stop Comparing LLM Agents Without Disclosing the
Harness* (arXiv:2605.23950); Anthropic Opus 4.6 system card; Terminal-Bench 2.0
leaderboard; Maruthi Prithivirajan, *The Harness Is the Real Product* (Aug 2026),
which compiles these figures.

### Harness-Bench

300 sandboxed work tasks, 7 native harnesses (Claude Code, Codex, OpenCode,
OpenClaw, Hermes, Goose, Nanobot), 10 model backends, final-artifact oracles
with partial credit and safety gates.

- Mean-score gaps across harnesses: **5.0–9.5 points** for nine models,
  **39.2 points** for Qwen3.8-27B.
- Full-credit gaps: GLM-5.3 varies **13.5 points**; GPT-5.6 Sol varies
  **9.12 points** despite the highest mean and a standard deviation of only
  1.93.
- Multimodal: Kimi-K3 scores **28.1 with Codex vs 72.7 with OpenClaw**.
- Cost does not buy delivery: with GPT-5.6 Sol, Nanobot costs **2.97×**
  OpenClaw and has a **lower** full-credit rate.
- Higher-scoring models are less harness-sensitive on mean score
  (Spearman ρ = −0.76), but full delivery remains sensitive. That is the
  practical argument for a model-agnostic harness with per-model tuning.

### The failure taxonomy

Harness-Bench's trajectory analysis groups recurring failures into:
evidence grounding, state management, tool selection, error recovery, and
verification. The recurring pattern is **execution alignment**: plausible
reasoning becomes decoupled from tool feedback, workspace state, evidence, or
the deliverable contract. A repaired tool call does not guarantee the workflow
resumes; a locally consistent output can still omit a required source file.

An earlier Harness-Bench summary reported the distribution as roughly:
contract/format violations **36.4%**, tool-recovery failures **24.6%**,
evidence-grounding **14.6%**, artifact-commitment **11.1%**, state-continuation
**9.3%**. Treat the exact split as version-dependent; the ordering is the
signal. **Most failure is not model reasoning.**

### Long-horizon, where it gets worse

*Long-Horizon-Terminal-Bench* (LHTB, arXiv:2607.08964):

- 46 containerized tasks, 9 categories, dense subtask grading.
- Average run: **231 episodes, 9.9M tokens, 85.3 minutes**.
- Best model: **15.2%** at the 0.95 reward threshold; **4.3%** mean across 15
  models.
- Of unresolved runs: **79% timeout while still working**, **19% early exit**,
  **3% harness error**.
- "False finishes": 14 runs stopped at reward ≥ 0.75 with time remaining.
- Near-misses (0.75–0.95) outnumber full passes **more than 2×**.

Conclusion: the binding constraint is not local correctness. It is **sustaining
progress, budgeting the horizon, and knowing when the work is actually done**.
Anchor already has budgets, a prose checkpoint, and a finish tool. It does not
have a durable notion of "what remains" that survives compaction and resets.

### Context is a budget with failure modes

- **Context rot**: accuracy degrades non-uniformly with input length; a single
  distractor hurts, four compound it. More context is not more capability.
- **Governance decay**: a June 2026 study (arXiv:2606.22528) reports **0 policy
  violations while the full policy stays visible**, rising to a **30% average
  violation rate after compaction** (up to 59% for some models). Constraints
  survive only if they are preserved explicitly.
- **Compression trade-off**: summary compression beats truncation on task
  success (72.8% vs 42.2% on AppWorld at a 2K budget) but **loses** on terminal
  completion (44.6% vs 77.2%). Compression makes agents better at solving and
  worse at stopping.
- **Cost at equal quality**: on a private multi-million-line codebase, average
  tokens per task were **237K (Pi), 742K (Claude Code), 1.235M (Codex)** at
  equivalent success. Pi uses four tools and a sub-1K-token prompt.

The design rule that follows: **offload rather than truncate, keep the recent
window verbatim, pin invariants outside the fold, and reset context with a
handoff instead of relying on lossy summaries alone.**

---

## 2. What the best harnesses actually do

| Mechanism | What good looks like | Evidence / example |
|---|---|---|
| **Filesystem + git as durable state** | Workspace, scratch, notes, commits, diffs; every long task can resume from artifacts | LangChain Deep Agents, OpenAI harness engineering, Anthropic long-running harness |
| **Context delivery** | Offload large results with a preview + path; compact distant history; keep recent verbatim; pin task spec and constraints | Deep Agents offloads >20K-token tool results; summarization at 85% with recoverable history |
| **Context reset + handoff** | Fresh context window with a structured artifact: feature list, progress log, git state, next steps | Anthropic: resets beat compaction for "context anxiety"; initializer + coding agent |
| **Progress ledger** | Machine-readable feature/task list with `passes`/status; agents may only flip status, never delete requirements | Anthropic `feature_list.json` with 200+ features; JSON is harder to overwrite than Markdown |
| **Verification gate** | Deterministic pre-completion checklist; tests run and read; a separate evaluator for judgment | LangChain `PreCompletionChecklistMiddleware`; Anthropic planner/generator/evaluator |
| **Separate evaluator** | Generator produces, evaluator tests against the spec; never self-grade | Anthropic: agents "confidently praise" their own mediocre work; split beat self-critique |
| **Tool interface** | Few consolidated tools; namespaced; examples in descriptions; actionable errors; ~10–25K token caps | Anthropic tool guidance; tool search 49%→74% and 77K→8.7K tokens; Codex uses `apply_patch`, `update_plan` |
| **Skills** | Progressive disclosure: metadata at startup, body on invoke, files on demand; tools can be bound to a skill | Agent Skills open spec; Deep Agents now supports `include_tools`, pinned skills, mid-thread reload |
| **Subagents** | Isolate noisy work; return only the result; do not parallelize coupled writes | Deep Agents subagents; DeLM evidence (below) |
| **Sandbox legibility** | Preinstalled toolchains, browser, logs/metrics, `init.sh`, repo map | OpenAI harness engineering; Anthropic Puppeteer/Playwright evaluator |
| **Model fit** | Prompt/tools tuned per model; reasoning budget shaped by phase | LangChain: 52.8→66.5 with GPT-5.2-Codex; xhigh-only 53.9 vs high 63.6; "reasoning sandwich" 66.5 |

### Verification is the strongest cheap lever

LangChain moved `deepagents-cli` from **52.8% to 66.5%** on Terminal-Bench 2.0
with the model fixed (GPT-5.2-Codex), by changing only the harness. Their
highest-impact changes:

1. Prompt the plan → build → verify → fix loop.
2. Inject environment context (directory map, available tools) at start.
3. Intercept exit with a pre-completion verification checklist.
4. Detect doom loops by per-file edit count.
5. Spend reasoning where it matters: high on planning and verification, medium
   in the middle ("reasoning sandwich").

Anthropic's three-agent harness (planner, generator, evaluator) is the same
idea at a larger scale. Their solo run built a broken retro game maker in 20
minutes for $9; the full harness ran 6 hours for $200 and produced a working
application. The evaluator used Playwright to drive the app and filed specific
bugs. They also found the evaluator's value depends on task difficulty relative
to the model: it is overhead when the model can already do the task solo.
Remove scaffolding as models improve; do not treat it as permanent.

### Multi-agent: coordination, not parallelism

The strongest 2026 result is **DeLM** (arXiv:2606.10662), a decentralized
multi-agent layer over existing harnesses:

- Parallel agents claim tasks from a queue and publish compact findings to a
  shared append-only context. No main agent relays progress.
- On Terminal-Bench 4.0 long-horizon tasks: **up to +17.5 accuracy points** and
  **up to 2.49× faster**; on DeepSWE v1.1, **+8.3 to +17.5 points**.
- **Native subagents often hurt.** Claude Code with native subagents on DeepSWE
  fell from **71.67% to 50.00%**, with **+15.9% latency** and **+65.1% cost**.
  Codex subagents matched accuracy at **2.9× cost**.
- Ablations: removing early sharing, peer-status awareness, or the shared
  context collapses the speedup to ~1×. **Two parallel agents are no faster than
  one unless they coordinate.**
- More agents is not monotonically better: n=4 was fastest but 3–4 points less
  accurate than n=2 because each agent still submits a complete solution and
  integration errors compound.

Anthropic's multi-agent study adds the failure modes: agents are low-variance
and conform (18/30 picked the same branch name); they collude; they fail to
share private evidence; and on conflicting goals they escalate into turf wars.
Coordination does not emerge from intelligence alone.

**Implication for Anchor:** build **one** well-scoped subagent primitive
(isolated context, result-only return, read-only by default) and a separate
evaluator before building "agent teams." Do not parallelize mutations in one
workspace.

### Memory: filesystem first, graph later

Consensus across LangChain, OpenAI, and Anthropic: **durable memory is plain
files in storage you control**, plus git history and a short project map
(`AGENTS.md`). It is inspectable, diffable, model-agnostic, and survives a
provider switch. Deep Agents: offload → summarize → skills → subagents →
long-term memory file.

Graph memory evidence is real but narrow:

- On multi-hop QA, structured recall beats chunk retrieval. Cognee's own
  benchmark: tuned Cognee **0.85** DeepEval correctness, Graphiti **0.74**,
  Mem0 **0.54** on a 24-question HotPotQA subset. Caveat: Cognee was tuned, the
  competitors were not; it is the vendor's own harness.
- Mem0 and Zep publish conflicting LoCoMo numbers (Mem0 ~91.6, Zep ~84.6; a
  third-party comparison reports very different values). Treat vendor memory
  benchmarks as directional.
- There is **no credible evidence** that a knowledge graph beats
  filesystem+git+grep for repository state. Code is already a graph with a
  canonical, versioned representation.

**Implication:** make project knowledge a file (`AGENTS.md` / `.anchor/` notes)
and, if we add graph memory, make it a consumer-owned adapter for cross-session
or organizational knowledge — not the core repo memory.

---

## 3. Anchor scorecard

Status: ✅ strong · 🟡 partial · ❌ missing

| Mechanism | Anchor today | Assessment |
|---|---|---|
| Durable state | sandbox workspace, git checkpoints, `.anchor/notes.md`, thread store | ✅ |
| Context compaction | summarization fold, assistant-text elision, spill | 🟡 lossy; no pinned invariants, no reset+handoff |
| Tool-result offload | `truncate`, bash spill | 🟡 not applied uniformly to every tool |
| Budgets | steps, tokens, USD, output cap, warnings | ✅ |
| Guardrails | repeat detection, empty-turn, silent-tool, verbose, prose checkpoint | ✅ among the best |
| Verification | `run_tests` evidence, prose checkpoint, finish tool | 🟡 no pre-completion checklist, no independent evaluator |
| Progress ledger | phases + notes | ❌ no machine-readable remaining-work contract |
| Context reset | none (thread resume only) | ❌ |
| Skills | none | ❌ |
| MCP / dynamic tools | none; fixed tool registry | ❌ |
| Subagents / evaluator | none | ❌ |
| Memory map | notes file | 🟡 no `AGENTS.md` ingestion or maintained project map |
| Tool interface | 5 tools + finish; `edit_file` string replace; no plan/browser/LSP/apply_patch | 🟡 solid core, narrow |
| Model routing / reasoning budget | one `LLMClient`, sampling pin | ❌ |
| Operation recovery | write-ahead journal, stable ids, reconciliation | ✅ unique; few harnesses have this |
| Trace/eval discipline | event stream, trace sinks, SWE-bench evals | 🟡 no harness A/B suite with dense partial credit |

**Anchor's genuine differentiators:** sandbox/provider contract with honest
capabilities, operation recovery for external effects, background jobs riding
an inbox chain, and a small, legible engine. Those are worth keeping and are not
where the score gap is.

---

## 4. Where the ceiling actually is

Ranked by expected score impact per unit of work:

1. **No progress ledger + verification gate.** Anchor can stop on prose,
   budget, or an explicit `finish`, but it has no durable answer to "what is
   still required?" That is exactly the LHTB failure mode: 79% timeouts and 19%
   false finishes. A JSON task list with status transitions, injected on resume,
   plus a required verification pass before `finish`, is the cheapest large
   gain.
2. **Lossy compaction without pinned invariants.** The engine folds the system
   prompt and task into summaries. Governance-decay evidence says constraints
   disappear at ~30% after compaction. Pin the task, acceptance criteria, and
   safety rules outside the fold; keep the recent window verbatim; offload the
   rest to a file.
3. **No context reset + handoff.** Compaction keeps the same agent and its
   "context anxiety"; a fresh window with a structured handoff is stronger for
   multi-hour work. Anchor already has a thread store and git checkpoints, so
   the handoff artifact is a natural extension, not a new subsystem.
4. **No skills / lazy tool disclosure.** Every tool schema is in context from
   turn 1. At 5 tools that is fine; at 50 (MCP) it is fatal. Skills + tool
   search + namespacing are the proven fix (Anthropic: 49%→74% with tool search;
   Deep Agents: bound tools load only with their skill).
5. **No independent evaluator.** Self-critique is reliably lenient. A second
   loop with a skeptical prompt and the ability to run the app/tests catches the
   last-mile gaps the generator misses. This is a subagent feature, but a
   specific, high-value one.
6. **Tool interface is narrow.** No plan/todo tool, no apply_patch-style edit, no
   browser, no semantic search/LSP, no `ask_user`. Tool descriptions are terse.
   Anthropic's data says small interface changes move parameter accuracy from
   72% to 90%.
7. **No harness A/B evaluation.** We cannot tell which of the above actually
   helps on *our* tasks. LangChain's trace-analyzer skill and Harness-Bench's
   dense, oracle-scored tasks are the model to copy.

Graph memory, large agent teams, and full parallel mutations are **not** in the
top list. The evidence does not support them as the next unlock for coding.

---

## 5. Proposed roadmap

### Tier 1 — harness-only, highest ROI (next 3–4 PRs)

**1. Progress ledger + verification gate** (S–M)
- `.anchor/progress.json`: `{ id, requirement, status: pending|in_progress|done|blocked, evidence }`.
- `update_plan` / `update_progress` tool; only status and evidence may change,
  never the requirement text.
- Injected into the prompt as a compact summary; full file readable on demand.
- `finish` is rejected unless every required item is `done` or explicitly
  `blocked` with a reason (consumer can override).
- On resume, the ledger is the first thing the model sees.

**2. Context discipline** (M)
- Pin system prompt, task, acceptance criteria, and safety constraints; exclude
  them from compaction.
- Offload every tool result above a token threshold to scratch with head/tail
  preview + path (generalize the bash spill).
- Keep the recent window verbatim; compact only the distant past.
- Add `contextReset` policy: at N% context or M steps, start a fresh window with
  a handoff artifact (ledger + git state + last observations), not a summary.

**3. Tool interface pass** (S–M)
- Add `update_plan`, `ask_user`, `view_image`, `list_processes` /
  `get_process_output`.
- Replace or supplement `edit_file` with an apply-patch-style tool.
- Rewrite descriptions with examples and failure guidance; enforce a 10–25K
  token result cap with actionable truncation.
- Evaluate prefix vs suffix namespacing on our own tasks.

**4. Harness A/B eval** (M)
- A small, replayable suite (10–20 tasks) with dense, deterministic checks:
  repo fix, multi-step terminal, research, and a long-running build.
- Same model, same sandbox, same budget; measure full-credit, partial reward,
  tokens, cost, wall-clock, and stopping behavior.
- Use it to accept/reject every Tier 1 change. Without this, we are tuning by
  vibes.

### Tier 2 — structural

**5. Skills** (M) — the design from the previous discussion. Add `include_tools`
binding, pinned skills, and mid-thread reload, matching Deep Agents.

**6. MCP with lazy discovery** (M) — `search_tools`, namespaced
`mcp__server__tool`, `EngineOptions.toolResolver`, per-server allowlists.
Reuse the operation journal for effectful MCP calls.

**7. Subagent + evaluator** (M) — single-level, isolated context, result-only
return, read-only by default. One `evaluate` subagent with a skeptical prompt
and test/browser tools. No parallel mutations, no teams yet.

**8. Model routing / reasoning budget** (S–M) — per-phase model and reasoning
effort: strong model for planning and verification, cheaper model for
exploration and summarization. This is the "reasoning sandwich" as an engine
option.

### Tier 3 — bets, only after measurement

**9. Project knowledge map** (S) — load a short `AGENTS.md`, let the agent
maintain a verified-facts section in `.anchor/`, inject the map not the manual.

**10. Graph memory adapter** (M) — consumer-owned, for cross-session or
organizational knowledge. Benchmark against the filesystem baseline before
promoting it. Do not make it core.

**11. Decentralized shared context** (L) — the DeLM pattern (task queue +
append-only findings + peer status) for multi-agent work in one workspace. Only
after the single-agent ledger and evaluator are solid; this is where the 17-point
gains live, but it is a large architectural commitment.

---

## 6. How we should measure from now on

Every harness result should report:

- model, harness commit, scaffold version
- task suite and threshold (full credit vs ≥0.8)
- tokens, cost, wall-clock, steps
- full-credit rate and mean partial reward
- failure split: timeout / early exit / harness error / false finish
- tool-error and recovery counts

Rules:
- Never compare models across different harnesses.
- Never accept a harness change on mean score alone; check full delivery and
  stopping behavior.
- Keep a held-out split. Harness search overfits; hand-designed changes
  transfer better, but only measurement can tell which is which.

---

## 7. What not to build now

- **Large agent teams / swarms.** Native subagents often reduce accuracy and
  raise cost; teams add coordination failure modes (conformity, collusion, turf
  wars). Build the evaluator and the ledger first.
- **Graph memory as core repo memory.** No evidence it beats filesystem + git
  for code. Revisit for cross-session knowledge only.
- **Parallel mutations in one workspace.** The single-flight gate is correct.
- **More tools for their own sake.** More tools increase selection errors. Add
  consolidated, high-signal tools with examples.

---

## Sources

1. Zhang et al., *Stop Comparing LLM Agents Without Disclosing the Harness*,
   arXiv:2605.23950, May 2026.
2. Yao et al., *Harness-Bench: Evaluating Agent Harnesses across Models and
   Realistic Workflows*, arXiv:2605.27922, v2 Oct 2026.
3. Li et al., *Long-Horizon-Terminal-Bench*, arXiv:2607.08964, Jul 2026.
4. Mao et al., *Decentralized Multi-Agent Systems with Shared Context*
   (DeLM), arXiv:2606.10662, Oct 2026.
5. Anthropic, *Patterns and problems in emerging multiagent systems*, Aug 2026.
6. Anthropic, *Effective harnesses for long-running agents*, Nov 2025.
7. Anthropic, *Harness design for long-running application development*,
   Mar 2026.
8. Anthropic, *Writing effective tools for agents*, Sep 2025.
9. LangChain, *Improving Deep Agents with harness engineering*, Feb 2026.
10. LangChain, *The Anatomy of an Agent Harness*, Mar 2026.
11. LangChain, *Context Engineering: How Deep Agents Remember*, Oct 2026.
12. LangChain, *Revamping Skills in Deep Agents*, Oct 2026.
13. OpenAI, *Harness engineering: leveraging Codex in an agent-first world*,
    Feb 2026.
14. OpenAI, *Codex prompting guide* (compaction, apply_patch, AGENTS.md,
    parallel tool calls, truncation), 2026.
15. Agent Skills specification, agentskills.io.
16. MCP specification 2026-07-28; Skills extension (SEP-2640); Tasks extension.
17. Maruthi Prithivirajan, *The Harness Is the Real Product*, Aug 2026
    (secondary compilation of harness-vs-model figures).
18. Context rot (Chroma, 2025); *Governance Decay* (arXiv:2606.22528, 2026);
    *Toward Reliable Context Compression for Long-Horizon Agents*
    (arXiv:2608.06503, 2026).
19. Cognee, *AI Agent Memory Benchmarks: Cognee vs. Mem0, Graphiti, and
    LightRAG*, 2026 (vendor benchmark; caveats stated in the post).
