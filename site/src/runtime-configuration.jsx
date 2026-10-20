import React from "react";
import * as Tabs from "@animate-ui/react/primitives/radix-ui/tabs";
import { CodeBlock } from "./ui.jsx";

const compactionExamples = [
  [
    "catalog",
    "From catalog",
    `import { chatAgent, llmFromCatalog, runAgent } from "anchor-ai-sdk";

const { llm, compaction } = await llmFromCatalog({
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_KEY,
  model: "z-ai/glm-5.3",
  fallbackCompaction: {
    maxEstimatedTokens: 60_000,
    keepRecentTokens: 15_000,
  },
});

// Pass the returned config; the factory does not apply it to runAgent for you.
const result = await runAgent(
  { task: "Explain this topic" },
  { llm, agent: chatAgent, compaction },
);`,
  ],
  [
    "explicit",
    "Explicit limits",
    `// llm and agent are configured by your host.
const result = await runAgent(
  { task: "Continue the investigation" },
  {
    llm,
    agent,
    compaction: {
      maxEstimatedTokens: 60_000, // start a fold above this estimate
      keepRecentTokens: 15_000,  // approximate recent tail to retain
    },
  },
);`,
  ],
  [
    "disabled",
    "Disabled",
    `const result = await runAgent(
  { task: "Answer this short question" },
  {
    llm,
    agent,
    compaction: false, // no automatic conversation summarization
  },
);
// Output elision/spill settings are separate. Context limits still apply.`,
  ],
];

export function CompactionGuide() {
  return (
    <>
      <p>
        Before a model turn, the engine estimates the conversation size. Above
        the configured threshold, it asks the same model to summarize older
        messages and retains a recent tail. This is lossy summarization, not a
        durable archive of the removed detail.
      </p>
      <Tabs.Root
        defaultValue="catalog"
        className="custom-agent-tabs compaction-config"
      >
        <Tabs.List aria-label="Compaction configuration">
          {compactionExamples.map(([id, label]) => (
            <Tabs.Trigger value={id} key={id}>
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {compactionExamples.map(([id, , code]) => (
          <Tabs.Content value={id} key={id}>
            <CodeBlock
              code={code}
              filename="compaction-options.mjs"
              language="JAVASCRIPT"
            />
          </Tabs.Content>
        ))}
      </Tabs.Root>
      <div className="tool-grid">
        <div>
          <code>maxEstimatedTokens</code>
          <span>
            When to attempt compaction. Engine fallback: 80,000 estimated
            tokens.
          </span>
        </div>
        <div>
          <code>keepRecentTokens</code>
          <span>
            Approximate recent conversation to keep. Engine fallback: 30,000
            estimated tokens. Boundaries are adjusted, not exact token cuts.
          </span>
        </div>
      </div>
      <p className="doc-small">
        Catalog-derived settings use the advertised context window:
        approximately 55%, with floor/ceiling rules and a 300k ceiling; the
        recent tail is 25% of that threshold. For a 128k window the helper
        returns 70,400 / 17,600. <code>fallbackCompaction</code> is used only
        when catalog window data is absent. The object passed to
        <code>runAgent</code> overrides the engine fallback fields; use object
        spread to tune the returned catalog configuration before passing it.
      </p>
      <CodeBlock
        code={`import { compactionForContextWindow } from "anchor-ai-sdk";

// For a known window, without fetching catalog metadata:
const compaction = compactionForContextWindow(128_000);
// { maxEstimatedTokens: 70400, keepRecentTokens: 17600 }

// Or tune the helper's ceiling/floor, then pass the result to runAgent:
const smaller = compactionForContextWindow(128_000, {
  ceiling: 60_000,
  floor: 24_000,
});`}
        filename="context-window.mjs"
        language="JAVASCRIPT"
      />
      <p>
        Estimates use characters divided by four, including tool-call text; they
        are not a model-specific tokenizer. Reserve space for instructions,
        tools, and output. A threshold is not a guarantee against context
        overflow, and a usable fold is not always possible.
      </p>
      <CodeBlock
        code={`import { MemoryThreadStore, runAgent } from "anchor-ai-sdk";

const store = new MemoryThreadStore(); // create once; in-memory, not durable
const result = await runAgent(
  { task: "Continue the same task" },
  {
    llm,
    agent,
    compaction: { maxEstimatedTokens: 60_000, keepRecentTokens: 15_000 },
    thread: { store, id: "investigation-42" },
    onEvent(event) {
      if (event.type === "compacted") {
        console.log(event.removedMessages, event.keptMessages, event.usage);
      }
    },
  },
);`}
        filename="thread-compaction.mjs"
        language="JAVASCRIPT"
      />
      <p className="doc-small">
        The summary is rebuilt into the strategy prompt; the current request is
        preserved. A supplied <code>ThreadStore</code> saves the summary,
        remaining messages, and phase. Use durable storage for cross-process
        continuity and configured trace sinks if you need an earlier journal.
        Summarization consumes model usage and is charged to the run budget.
        Disk notes, tool-output spill, and assistant-text elision are separate
        mechanisms.
      </p>
    </>
  );
}

const correctionExamples = [
  [
    "defaults",
    "Defaults",
    `// Runtime options for a configured llm / agent / optional sandbox:
const result = await runAgent({ task }, {
  llm, agent, sandbox,
  guardrails: {
    repeatedToolCallLimit: 3,
    toolOnlyNudgeLimit: 8,
    verboseTurnLimit: 8_000,
    proseCheckpoint: true,
  },
  maxOutputTokens: 16_000,   // provider request limit, not replay size
  maxAssistantChars: 20_000, // replay limit for one assistant reply
  truncatedReplyChars: 12_000, // head-only replay after an output cap
});`,
  ],
  [
    "tuned",
    "Tuned example",
    `// Example choices, not a recommended universal profile.
const result = await runAgent({ task }, {
  llm, agent, sandbox,
  budgets: { maxSteps: 60, maxUsd: 3 },
  guardrails: {
    repeatedToolCallLimit: 4, // tolerate more identical calls
    toolOnlyNudgeLimit: 5,   // request visible status earlier
    verboseTurnLimit: 6_000, // nudge long visible turns earlier
    proseCheckpoint: true,
  },
  maxOutputTokens: 12_000, // keep above the verbosity threshold
  maxAssistantChars: 16_000,
  truncatedReplyChars: 8_000,
  revival: { warnAtPercent: 80 }, // optional, separate budget warning
  onEvent(event) {
    if (event.type === "advisory") console.log(event.kind, event.detail);
  },
});`,
  ],
  [
    "disabled",
    "Disable controls",
    `const result = await runAgent({ task }, {
  llm, agent, sandbox,
  guardrails: {
    repeatedToolCallLimit: false,
    toolOnlyNudgeLimit: false,
    verboseTurnLimit: false,
    proseCheckpoint: false,
  },
  maxOutputTokens: false,
  maxAssistantChars: false,
  truncatedReplyChars: false,
  revival: false,
  // Keep a run budget. Disabling these controls can increase cost/context.
  budgets: { maxSteps: 20, maxUsd: 1 },
});
// This does not disable every fixed recovery path; see the notes below.`,
  ],
];

export function CourseCorrectionGuide() {
  return (
    <>
      <Tabs.Root
        defaultValue="defaults"
        className="custom-agent-tabs correction-config"
      >
        <Tabs.List aria-label="Course correction configuration">
          {correctionExamples.map(([id, label]) => (
            <Tabs.Trigger key={id} value={id}>
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {correctionExamples.map(([id, , code]) => (
          <Tabs.Content value={id} key={id}>
            <CodeBlock
              code={code}
              filename="guardrail-options.mjs"
              language="JAVASCRIPT"
            />
          </Tabs.Content>
        ))}
      </Tabs.Root>
      <div className="agent-interface-fields">
        {[
          [
            "repeatedToolCallLimit",
            "Default 3. Byte-identical name/argument calls are counted. The repeat is skipped, one redirect is allowed, and another loop can stall the run. This is not semantic detection of every unproductive action.",
          ],
          [
            "toolOnlyNudgeLimit",
            "Default 8 consecutive tool-call turns without visible text. Injects a one-shot status/action advisory; it is not a requirement to respond every eight turns.",
          ],
          [
            "verboseTurnLimit",
            "Default 8,000 visible output tokens. Current source subtracts provider-reported reasoningTokens from completionTokens and clamps at zero. If reasoning usage is absent, it cannot be subtracted. Fires once per run.",
          ],
          [
            "proseCheckpoint",
            "Default true. With the finish intrinsic available, a prose-only reply following an engine nudge gets one confirmation/correction turn before it is accepted as an answer. Not a gate on every normal prose reply.",
          ],
          [
            "maxOutputTokens",
            "Default 16,000, requested from the provider for each main generation. A capped prose turn can continue once when proseCheckpoint is enabled; repeated capped prose can still stall. A cap can interrupt or omit a tool call.",
          ],
          [
            "maxAssistantChars / truncatedReplyChars",
            "Defaults 20,000 / 12,000 characters, not tokens. Bound replay of the model’s own text; they are not verbosity nudges or conversation compaction. The stricter truncated-reply limit never raises the main replay limit.",
          ],
        ].map(([name, explanation]) => (
          <div key={name}>
            <code>{name}</code>
            <p>{explanation}</p>
          </div>
        ))}
      </div>
      <p className="doc-small">
        Use positive numbers or <code>false</code> for numeric switches;{" "}
        <code>0</code> is invalid. Empty-turn recovery is a fixed one-shot path
        in the reviewed source, not a public <code>emptyTurnLimit</code> option.
        Advisory text and retry counts are not individually configurable through
        this interface. <code>onEvent</code> observes events; it does not
        replace engine nudges. Put domain instructions in your strategy prompt.
      </p>
      <p className="doc-small">
        Budget revival warnings use the separate opt-in{" "}
        <code>revival.warnAtPercent</code>. Phase-discipline guidance is
        controlled with <code>intrinsics.phase</code>, not a guardrail
        threshold. These mechanisms guide or bound execution; they do not
        guarantee progress, correctness, or authorization.
      </p>
    </>
  );
}

export const revivalLoopExample = `import {
  codingAgent, MemoryThreadStore, ThreadBudget, planRevival, runAgent,
} from "anchor-ai-sdk";

// Your host supplies a configured provider, model and repository.
export async function runWithRevival({ llm, compaction, provider, repoUrl, task }) {
  const store = new MemoryThreadStore(); // demo only; not durable
  const threadBudget = new ThreadBudget({ maxTurns: 3, maxUsd: 8 });
  const runBudget = { maxSteps: 40, maxTokens: 3_000_000, maxUsd: 2 };
  const sandbox = provider.create({ repoUrl, ref: "main" });
  let startPhase;

  try {
    await sandbox.start();
    for (;;) {
      // Leave insufficient funding to a human, rather than assume a free run.
      if (threadBudget.exhausted || threadBudget.usdLeft < runBudget.maxUsd) {
        return { action: "needs_human", note: "Thread funding is insufficient." };
      }
      const result = await runAgent(
        { task }, // preserve the original task on every run
        {
          llm, compaction, agent: codingAgent, sandbox,
          thread: { store, id: "task-42" },
          budgets: runBudget,
          revival: { warnAtPercent: 85 },
          ...(startPhase ? { startPhase } : {}),
        },
      );

      // A budget ending normally returns an AgentResult; it is not a throw.
      threadBudget.record({ usd: result.usage.costUsd });
      if (result.usage.costUsd === undefined) {
        return { action: "needs_human", note: "Cost is unknown.", result };
      }
      const plan = planRevival({ result, task, threadBudget });
      if (plan.action === "needs_human") {
        return { ...plan, result }; // your UI/worker must deliver this note
      }
      if (plan.action !== "revive") {
        return { action: "stopped", result }; // inspect reason and evidence
      }

      console.log("Continuing:", plan.remaining);
      startPhase = plan.startPhase;
      // Same sandbox, thread, task and per-run budget; next iteration resumes.
    }
  } finally {
    await sandbox.destroy();
  }
}

// With llm / compaction from the model setup and provider from sandbox setup:
// const outcome = await runWithRevival({ llm, compaction, provider, repoUrl, task });
// Do not automatically retry thrown setup/transport exceptions.`;

const revivalWorkerExample = `import { ThreadBudget, planRevival } from "anchor-ai-sdk";

// App-owned callbacks: the SDK does not provide a database or a job queue.
export async function handleRunResult({
  runId, task, result, storedSpend, limits, saveAndEnqueueOnce, notifyHuman,
}) {
  // Rehydrate persisted spend; maxTurns counts runs, not tool steps.
  const threadBudget = new ThreadBudget(limits, storedSpend);
  threadBudget.record({ usd: result.usage.costUsd });
  if (result.usage.costUsd === undefined) {
    await notifyHuman("Known-cost funding cannot be checked for this run.");
    return;
  }

  const plan = planRevival({ result, task, threadBudget });
  if (plan.action === "revive") {
    await saveAndEnqueueOnce({
      runId,
      spend: { turnsUsed: threadBudget.turnsUsed, usdSpent: threadBudget.usdSpent },
      task: plan.task,
      startPhase: plan.startPhase,
      remaining: plan.remaining,
      checkpointRef: result.checkpointRef,
    });
  } else if (plan.action === "needs_human") {
    await notifyHuman(plan.note);
  }
}
// saveAndEnqueueOnce must atomically persist this run/spend and deduplicate by
// run ID. Also persist spend for non-revived outcomes in your completion path.
// The next worker uses the same durable ThreadStore + id and run budget.
// Use retained sandbox handles/openSandboxSession, or restore a pushed Git
// checkpoint via a fresh sandbox spec. startPhase alone restores no files.`;

export function RevivalGuide() {
  return (
    <>
      <p>
        Enable the handoff mechanism in <code>runAgent</code>, then make the
        continuation decision in your host. The engine warns near budget limits
        and offers <code>request_revival</code>; it does not fund or schedule
        another run.
      </p>
      <CodeBlock
        code={`// Inside runAgent(task, options):
revival: { warnAtPercent: 85 },
thread: { store: threadStore, id: "task-42" },
budgets: { maxSteps: 40, maxTokens: 3_000_000, maxUsd: 2 },`}
        filename="enable-revival.ts"
      />
      <Tabs.Root
        defaultValue="loop"
        className="custom-agent-tabs revival-config"
      >
        <Tabs.List aria-label="Revival orchestration">
          <Tabs.Trigger value="loop">Same process</Tabs.Trigger>
          <Tabs.Trigger value="worker">Worker / queue</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="loop">
          <CodeBlock
            code={revivalLoopExample}
            filename="run-with-revival.mjs"
            language="JAVASCRIPT"
          />
        </Tabs.Content>
        <Tabs.Content value="worker">
          <CodeBlock
            code={revivalWorkerExample}
            filename="handle-run-result.mjs"
            language="JAVASCRIPT"
          />
        </Tabs.Content>
      </Tabs.Root>
      <div className="tool-grid">
        <div>
          <code>revive</code>
          <span>
            A budget-limited result has handoff/checkpoint evidence and thread
            caps remain. The planner returns the task, phase and remaining-work
            text.
          </span>
        </div>
        <div>
          <code>needs_human</code>
          <span>
            The planner sees exhausted thread caps for an otherwise revivable
            result. Your app delivers the note and decides whether funding or
            scope changes.
          </span>
        </div>
        <div>
          <code>none</code>
          <span>
            No applicable budget ending or handoff evidence. This is not
            success; inspect result.reason, result.ok and evidence.
          </span>
        </div>
        <div>
          <code>maxTurns / maxUsd</code>
          <span>
            Thread-wide recorded spend, supplied by your app. Missing cost
            defaults to zero in the tracker; the examples deliberately escalate
            instead.
          </span>
        </div>
      </div>
      <p className="doc-small">
        The planner reacts to <code>max_steps</code>/
        <code>budget_exceeded</code> and a revival request or checkpoint.
        Requests and retained machines can be absent; do not assume either
        exists. Run budgets are checked between model calls and may overshoot.
        ThreadBudget is bookkeeping, not a billing reservation or exactly-once
        scheduler. A process crash can lose in-memory stores and spend.
      </p>
      <p className="doc-small">
        With a native inbox, one returned result can cover a chain. Record its
        cumulative usage once, or sum the per-run deltas in <code>result.runs</code>,
        not both. Outstanding background jobs returned at a final chain boundary
        must be persisted and supplied as <code>resumeJobs</code> after restoring
        the same retained machine. Inbox continuation is separate from funding
        a budget-exhausted revival.
      </p>
      <p className="doc-small">
        For cross-process resume, persist conversation/summary/phase in your
        ThreadStore, thread spend and the completed run ID in your database, and
        the workspace via retention or a remote checkpoint. Pass the same thread
        ID and a started/adopted sandbox to the next run. Explicit{" "}
        <code>startPhase</code> selects the label; it does not restore the
        conversation or repository by itself.
      </p>
    </>
  );
}
