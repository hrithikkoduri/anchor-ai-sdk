# Task contracts — one agent, contracts the agent creates, a typed judge

This brief is self-contained: read it top to bottom before changing code.

Repo: `anchor-ai-sdk` (this repo). Do **not** edit `sailor` or `sailor-cloud`;
a separate agent adopts this change there.

---

## 1. What we hit

A user typed this into a thread in Sailor:

> Can we implement support for Daytona in our the anchor sdk just like we did
> for e2b and heyo

It was a clear request for work. Nothing happened. The run (`8b8974ca`,
`agent = "chat"`, 3 steps) reasoned correctly, tried `bash`, got back
`Assistant mode is read-only. Start a task before editing, running commands,
publishing, or switching repositories.`, inspected the workspace read-only, and
replied:

> I can do this, but not from here… Next step: start this as a task on the
> thread.

There is no "start a task". It was a dead end, and the model was not at fault.

The cause is four decisions stacked:

1. **Sailor routed by event provenance.** `drainInbox` said: a batch made only
   of `chat_message` rows is a conversation turn, so the run is created with
   `agent = "chat"`. A GitHub event made it `"coding"`.
2. **`agent = "chat"` meant assistant mode.** The prompt said "do not edit",
   and five tools were replaced with stubs that return the message above.
3. **Anchor had a second router.** `routeTurn` in `engine/loop.ts` regex-classifies
   the task text (`src/engine/intent.ts`) and can swap in Anchor's own
   `chatAgent`. It only runs when `verifier` is enabled, so it never saw these
   runs — but it duplicated the same policy with the same regex.
4. **`verifier: true` compiled a contract at run start for every turn.** So a
   greeting got a ledger and a finish gate. The only way a consumer could avoid
   that was to turn the verifier off — which is why "assistant mode" existed as
   a separate licence level in the first place.

Two routers, a mode flag, tool stubs and a prompt branch all existed to answer
one question: **does this turn get a contract?** We are deleting the question
and letting the agent answer it with a tool call.

## 2. The model after this change

- **One agent.** No chat/coding split, no profiles, no intent routing, no
  mode-specific prompt or tool stubs. The strategy's phases are the loop.
- **Messages are the input.** A run is a turn in a conversation, not a task.
- **A contract exists only because the agent called `create_task`.** A run
  without one is a conversation with the same tools; no ledger, no gate, no
  compile call.
- **A judge (Jeff) verifies at phase boundaries and at finish**, with
  per-requirement verdicts. The agent writes the evidence case; the judge
  scores it.
- **Requirements own a phase**, so leaving a phase has a meaning and skipping
  one is self-defeating rather than forbidden.

What disappears: `intent`, `routeTurn`, `resolveTurnIntent`, the `chatAgent`
swap, the compile-at-start call, `RunTask.task`.

What stays: `ThreadStore`, `InboxStore`, compaction, snapshots, revival,
operations, budget, phases.

---

## 3. Change list

### 3.1 Remove turn routing (breaking)

- Delete `src/engine/intent.ts` and its export.
- Delete `routeTurn()` and the `priorLedgerFor` call that only existed to route.
- Remove `EngineOptions.intent`.
- `runOne` uses `opts.agent` (or `opts.strategy`) only. Remove the
  `opts.agent ?? chatAgent` / `opts.agent ?? codingAgent` fallback inside
  routing; `runOne` already requires an agent or strategy at line ~138.
- `runChain` no longer re-routes per run.

### 3.2 `RunTask` becomes `RunInput` (breaking)

The engine currently takes one request string and wraps it:

```ts
runAgent({ task: "…", images }, opts)
// loop.ts: const currentRequest = userMessage(task.task, task.images)
```

Replace it with a message delta:

```ts
export interface RunInput {
  /**
   * The new turn's messages, oldest first. Appended to the thread's stored
   * conversation by the engine. Usually one user message; a coalesced inbox
   * batch may be several.
   */
  messages: LLMMessage[];
  /** Repo map / workspace description. Never persisted as a message. */
  context?: string;
}

runAgent(input: RunInput, opts: EngineOptions): Promise<AgentResult>
```

Rules:

- The thread store holds the conversation **up to, excluding** this turn. The
  input is the delta. `messages = [system, ...prior.messages, ...input.messages]`.
- Without a thread store, `input.messages` is the whole conversation.
- Images ride on `LLMMessage.images` (already supported). Delete `RunTask`.
- Keep a tiny helper `userTurn(text): RunInput` for tests, CLI and examples.

Migration points:

| Where | Change |
| --- | --- |
| `engine/types.ts` | `RunTask` → `RunInput` |
| `engine/loop.ts:247,275,302,365,382,1111` | `task.task` → the derived request text (see 3.3) or `input.context` |
| `engine/inbox.ts:183` | `renderInboxTask` → `renderInboxTurn(messages): RunInput`, one user message per inbox message (do not join them into a blob) |
| `engine/events.ts:22` | `run_started` carries `{ text, messages?, phases }` where `text` is the rendered turn for humans |
| `engine/strategy.ts` | `systemPrompt({ task, context, summary })` → `systemPrompt({ context, summary })`; neither built-in strategy uses `task` |
| `ledger/compiler.ts` | `task: string` → `source: string` |
| `ledger/alignment.ts`, `verify/*` | `task` → `request` |
| `examples/`, `tests/helpers` | new input shape |

### 3.3 The contract source is derived, not self-reported

`create_task` must not take a `source` field — that would let the agent author
the standard it is judged against. The engine derives it:

```ts
const requestText = input.messages
  .filter((m) => m.role === "user" && m.content?.trim())
  .map((m) => m.content!)
  .join("\n\n");
```

`sourceQuote` validation in `compileLedger` now checks against this text.
`create` with `"start"` uses the same derivation.

### 3.4 `create_task` intrinsic

Registered when `verifier` is enabled and no active contract exists, unless
`intrinsics.task === false`.

```json
{
  "goal": "one sentence outcome",
  "requirements": [
    { "text": "concrete, checkable", "required": true, "phase": "validate",
      "sourceQuote": "optional exact substring of the request" }
  ],
  "nextStep": "optional"
}
```

On call:

1. Validate: non-empty goal, 1–12 requirements, `phase` is one of
   `strategy.phases` ids, `sourceQuote` present in the derived request text.
2. Build the ledger (`createLedger`, origin `"agent"`); `source.text` is the
   derived request text, `source.kind` is `"user"`.
3. Attach it: `ledger` variable, `available.set("update_ledger", …)`, set
   `completionGate`, register phase gating.
4. Emit `{ type: "task_created", ledger }`.
5. Return the requirement ids and texts so the model knows the standard.

If a contract is already active, return a failed result: "the contract is already
active; use update_ledger". This keeps the tool schema stable (prompt cache).

`VerifierConfig.create?: "agent" | "start"`, default `"agent"`. `"start"`
preserves today's compile-at-run-start behaviour for consumers that want it.

### 3.5 Evidence carries an argument

```ts
export interface LedgerEvidenceRef {
  // …
  /** Why this result establishes the linked requirement (agent-authored). */
  claim?: string;
}
```

`update_ledger` changes:

- `op: "link_evidence"` requires `claim` (1–400 chars). Linking without an
  argument is how an agent marks things verified by assertion.
- New `op: "verify"` = link + `verified` in one call:
  `{ requirementId, evidenceId, claim }`. This removes the two-call
  `link_evidence` + `set_status` dance.
- `op: "set_status"` with `verified` still refuses without a linked evidence.

### 3.6 The judge seam

The verifier is no longer an LLM prompt behind `VerifierConfig.llm`. Introduce a
transport-neutral seam so a typed decision model and a prose LLM can both serve:

```ts
// src/verify/judge.ts
export interface JudgeCase {
  /** The run's derived request text. */
  request: string;
  phase: { id: string; goal: string; guidance?: string };
  ledger: ProgressLedger;           // requirements + evidence + claims
  /** Evidence captured since this phase began, oldest first. */
  evidenceSincePhase: LedgerEvidenceRef[];
  /** The `reason` the agent passed to set_phase. */
  agentReason?: string;
}

export interface JudgeVerdict {
  cleared: boolean;
  requirements: Array<{
    id: string;
    status: "cleared" | "insufficient" | "unproven";
    /** Calibrated probability when the judge returns one. */
    probability?: number;
  }>;
  confidence: number;
  /** Prose judges only; typed judges have none. */
  rationale?: string;
  /** Judge model identity + spend, for the trace and the budget. */
  model?: string;
  usage?: LLMUsage;
}

export interface Judge {
  name: string;
  judge(c: JudgeCase, signal?: AbortSignal): Promise<JudgeVerdict>;
}
```

`VerifierConfig`:

```ts
export interface VerifierConfig {
  judge?: Judge;                    // preferred
  llm?: LLMClient;                  // sugar for llmJudge(llm), kept for compat
  create?: "agent" | "start";       // default "agent"
  gates?: Array<"phase" | "finish">;
  allowWaived?: boolean;
  maxCallsPerTask?: number;         // default 8
  maxRejectionsPerPhase?: number;   // new, default 3
  /** Judge outage policy. Default allow-with-warning. */
  onError?: "allow" | "block";
}
```

Ship two adapters:

- `llmJudge(llm)` — today's `verifyAlignment`, reshaped to `JudgeCase` /
  `JudgeVerdict`. Its schema must return per-requirement verdicts plus a
  rationale, not one global `allow`.
- `jevJudge({ apiKey, model?, endpoint?, thresholds? })` — TypeSafe AI's Jev
  (see §4).

### 3.7 Phase-owned requirements and the boundary gate

- `create_task` requirements carry `phase`.
- `set_phase(target)` verifies the **outgoing** phase: every requirement with
  `phase === currentPhase` and `status` not settled.
- If the outgoing phase owns no requirements, allow without a judge call.
- One judge call carries all of them plus a phase-level question. On rejection,
  return a failed tool result naming each unmet requirement, its probability and
  its claim; the model stays in the phase and keeps working.
- After `maxRejectionsPerPhase` rejections, allow the transition and leave the
  requirement `in_progress`. It still blocks `finish`; the run cannot deadlock.

### 3.8 Finish, prose, and the honest blocked exit

- A contract arms `completionGate`. A prose-only final turn is gated exactly as
  `finish` is (this already exists at `loop.ts:~1472`); three rejections end the
  run `stalled`, `ok: false`. Keep that.
- **Fix:** `completionGate` currently ignores `success` (`completionGate(summaryText)`
  at `loop.ts:328`). `finish({ success: false })` must be allowed to end a run:
  record the open requirements as open failures, return `ok: false` with
  `reason: "finished"`. Otherwise the honest exit is the one we punish.
- A fully settled ledger is **not** an active contract. When loading a prior
  ledger, if `ledgerGate(ledger).allow` and there are no open failures, do not
  attach it and do not block `create_task`.

### 3.9 Events

- `{ type: "task_created"; ledger }`
- `{ type: "phase_verdict"; phase: string; cleared: boolean; confidence: number;
    judge: string; requirements: Array<{ id, status, probability? }> }`
- `run_started` as described in 3.2.

`phase_verdict` is what lets a consumer's UI explain a send-back ("r2 0.31 —
test output does not establish 'retry test passes'"). Do not put prose in it
that the judge did not produce.

---

## 4. Jev

Jev is TypeSafe AI's "System One" model (`jev-1.13.0`, alias `jev-latest`;
`jev-1.14.0` behind `jev-preview`). It does not generate text. You send a
`state` plus named questions and get typed answers with calibrated
probabilities:

- `noul` — yes/no probability
- `choice` — one of ≤255 labelled options
- `score` — a point on a 2–10 level rubric

Facts that matter for us:

- ~$0.042 per MTok **input**, output free; 70–500 ms per call.
- Per-request context 64k (`state` + all questions), per-question 32k.
- All questions are answered in parallel in one round trip.
- It cannot hallucinate an option, but it can pick a wrong one — hence the
  probabilities.
- Independent evals: strong on binary `noul` (≈1.8% error on the cases it
  decides), but it abstains often, and binary probabilities **must be
  thresholded on our own data** — 0.5 is badly placed.
- It is weak at fine-grained multi-way choice, counting, and arithmetic. Use
  `noul`, not a many-way `choice`, and never ask it to do maths.
- Access: `POST /v1/systemone` (early access), or via OpenRouter's Decisions
  API (`/api/alpha/decisions`) or Vercel AI Gateway. It is **not** a
  chat-completions endpoint.

`jevJudge` shape:

```
state = {
  request, phase: {id, goal},
  requirements: [{ id, text, phase, status, claim,
                   evidence: [{ tool, ok, summary, meta }] }],
  agentReason
}

questions = {
  phase_complete: noul("The agent's work in this phase is complete enough to leave it."),
  r1: noul("The cited evidence establishes: <r1.text>. The agent's claim is: <r1.claim>.
            Reject claims that restate the requirement, name a test without its
            output, or cite an edit without a passing check."),
  r2: noul(…),
  …
}

thresholds = { cleared: 0.8, rejected: 0.5 }
```

Verdict mapping: per-requirement `noul >= cleared` → `cleared`; `<= rejected` →
`unproven`; between → `insufficient`. Phase `cleared` only if every required
requirement with this phase is `cleared` and `phase_complete >= cleared`.
`confidence` is the minimum probability involved.

If a prose judge is also configured, low-confidence cases may be escalated to it
once; that is optional and must respect `maxCallsPerTask`.

Do not ask Jev for the gap text. Compose the send-back deterministically from
the requirement text, its claim and its probability.

---

## 5. Tests (acceptance)

Keep the suite green; add:

1. `create_task` is not called → no ledger, no gate, a prose answer ends the run.
2. `create_task` mid-run → `update_ledger` becomes available, the ledger block
   appears on the next call, `task_created` is emitted.
3. A claim is required to link evidence; `verify` does it in one call.
4. `set_phase` with an owned, unmet requirement is rejected and names it; with
   no owned requirements it does not call the judge.
5. N rejections allow the transition but leave the requirement open; `finish`
   still cannot pass.
6. `finish({ success: false })` ends the run `ok: false` with open failures.
7. A fully settled prior ledger does not attach and does not block `create_task`.
8. `RunInput.messages` appends to stored history and does not duplicate it;
   `renderInboxTurn` produces one message per inbox row.
9. `jevJudge` maps `noul` bounds to cleared/insufficient/unproven and respects
   the configured thresholds (fake HTTP, no network in tests).
10. Removing routing: a chat-shaped request and a task-shaped request run the
    same agent with the same tools; only `create_task` changes the run.

Delete the four routing tests in `tests/unit/engine-verifier.test.ts` and the
`intent`-specific cases.

## 6. Docs and gates

- `DECISIONS.md`: add **#67 — contracts are created by the agent; one agent, no
  modes; the judge is a seam**. State the incident above as the reason.
- `README.md`: replace `runAgent({ task })` examples with `runAgent({ messages })`;
  document `create_task`, the judge seam and `create`/`gates`.
- Gates: `npm run typecheck && npm test && npm run build`.

## 7. Out of scope

Do not add here: `revise_task` (user-directed scope change), subagents, browser
tools, MCP, per-account model routing, or any Sailor-specific policy.
`compileLedger` stays exported and gains `create: "start"` as its only path into
a run.
