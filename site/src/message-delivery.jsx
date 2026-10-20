import React from "react";
import * as Tabs from "@animate-ui/react/primitives/radix-ui/tabs";
import { CodeBlock } from "./ui.jsx";

export const nativeInboxExample = `import { MemoryInboxStore, MemoryThreadStore, runAgent } from "anchor-ai-sdk";

// Create once per host/session, not once per message. Memory stores are demo-only.
const inboxStore = new MemoryInboxStore();
const threadStore = new MemoryThreadStore();
const channel = "thread-42";

// Worker: llm, agent and any started sandbox come from your host setup.
const processing = runAgent({ task: "Investigate the retry behavior" }, {
  llm, agent, sandbox,
  thread: { store: threadStore, id: channel },
  inbox: { store: inboxStore, channel },
  budgets: { maxSteps: 60, maxUsd: 3 }, // shared across this call's chain
});

// Call from your authenticated HTTP/websocket/webhook handler while it runs.
async function onIncomingMessage(message) {
  return inboxStore.push({
    id: message.id, // stable, globally unique ID; retries reuse it
    channel,
    text: message.text,
    delivery: message.delivery, // your policy chooses queue or interject
    ...(message.context !== undefined ? { context: message.context } : {}),
  });
}

const result = await processing;
console.table(result.runs ?? []); // reason, steps, phase, summary, per-run usage
console.log(result.usage); // cumulative usage for the whole chain
// An external signal/cancel stops the chain. Interjections use inbox policy,
// not an AbortController that the consumer needs to manage.`;

const producerExample = `// Same store/channel as the worker. These are native InboxStore.push calls.
await inboxStore.push({
  id: "thread-42:comment:101",
  channel: "thread-42",
  text: "Also explain the timeout handling",
  delivery: "queue",
});

await inboxStore.push({
  id: "thread-42:comment:102",
  channel: "thread-42",
  text: "Change direction: inspect the timeout before editing retry logic",
  delivery: "interject",
});
// Pushing after processing has returned does NOT start a daemon or model call.
// Your host must wake a worker and supply an initial task to a new runAgent call.
// Keep one owner per thread/workspace; do not run competing chains.`;

const rendererExample = `const result = await runAgent({ task }, {
  llm, agent, sandbox,
  thread: { store: threadStore, id: channel },
  inbox: {
    store: inboxStore,
    channel,
    render(batch) {
      // Store order: newest-first interjections, then oldest-first queued items.
      // The default renderer simply joins all text and optional context.
      return {
        task: batch.map(message =>
          (message.delivery === "interject" ? "Correction: " : "Queued: ")
          + message.text
        ).join("\\n\\n"),
        context: batch.map(message => message.context ?? "").filter(Boolean).join("\\n"),
      };
    },
  },
});
// This is rendering, not automatic deletion/superseding of older instructions.
// Keep render deterministic and non-throwing; claimed batches need lease recovery.`;

const contextExample = `import { chatAgent, runAgent } from "anchor-ai-sdk";

const agent = {
  ...chatAgent,
  strategy: {
    ...chatAgent.strategy,
    systemPrompt(args) {
      return chatAgent.strategy.systemPrompt(args)
        + (args.context ? "\\n\\n# Application context\\n" + args.context : "");
    },
  },
};
const result = await runAgent({
  task: "Summarize my account", // the user-facing request
  context: "Authorized facts: plan=starter; region=eu", // app-owned data
}, { llm, agent });

// Default chatAgent ignores context unless its strategy consumes it.
// CodingAgent uses explicit context instead of its normal repo-map preparation.
const runtimeFacts = result.messages.filter(message => message.origin === "runtime");
const visibleMessages = result.messages.filter(message =>
  message.role !== "system" && !["engine", "runtime"].includes(message.origin)
);
// Filtering is an app UI choice, NOT secrecy. The model sees the facts and may
// repeat them. Audit/redact before displaying or storing sensitive content.`;

export function MessageDeliveryGuide() {
  return <>
    <p>SDK <strong>0.1.7</strong> includes native <code>InboxStore</code>, <code>MemoryInboxStore</code>, and <code>EngineOptions.inbox</code>. Your producer pushes messages; the SDK checks interjections at safe turn boundaries and drains pending batches between runs. The host does not need its own abort-and-restart loop for inbox delivery.</p>
    <Tabs.Root defaultValue="native" className="custom-agent-tabs message-config"><Tabs.List aria-label="Inbox and context examples">{[["native", "Run with inbox"], ["push", "Push messages"], ["render", "Batch rendering"], ["context", "Context & UI"]].map(([id, label]) => <Tabs.Trigger value={id} key={id}>{label}</Tabs.Trigger>)}</Tabs.List>{[["native", nativeInboxExample], ["push", producerExample], ["render", rendererExample], ["context", contextExample]].map(([id, code]) => <Tabs.Content value={id} key={id}><CodeBlock code={code} filename={`${id}-messages.mjs`} language="JAVASCRIPT" /></Tabs.Content>)}</Tabs.Root>
    <div className="tool-grid"><div><code>queue</code><span>Does not enter the active run. After the run ends, pending messages can be claimed and combined as the next run's task.</span></div><div><code>interject</code><span>Requests a switch at the next engine boundary. The current turn is not spliced mid-tool-call; a new run follows with the claimed batch.</span></div></div>
    <p>One configured budget covers the chain; messages do not refill it. The chain stops on cancellation, pause, errors, or exhausted allowance. It can also end when no batch remains. A stalled run may continue if inbox work is available. A zero-progress safeguard limits repeated pre-model interruptions; there is no public <code>maxRuns</code> option.</p>
    <h3>Implement a production store</h3>
    <div className="agent-interface-fields">{[
      ["push(message)", "Return queued or duplicate. Store a stable ID, channel, text, optional context, delivery, and your ordering/state data. Use globally unique IDs; completion/release identify messages by ID, not a channel argument."],
      ["hasInterject(channel)", "Cheap existence check at run boundaries. It does not claim/delete messages. Current engine treats a lookup error as no interjection."],
      ["claimAll(channel)", "Atomically claim the pending batch: interjections newest-first, then queued oldest-first. Claimed items cannot be returned to competing claims until released or recovered through your lease policy."],
      ["complete(ids) / release(ids)", "The engine settles after the consuming run: release on error/cancel, otherwise complete. This is not an assertion that every instruction caused a model action. Retrying released work can repeat already-performed side effects; use application idempotency."],
      ["hasPending(channel) · optional", "Allows a normal finish with outstanding jobs to skip its wait when inbox work is pending. Without it, normal wait-before-finish behavior remains. Pending work is not a reservation of budget or a guarantee the next run will start."],
    ].map(([field, text]) => <div key={field}><code>{field}</code><p>{text}</p></div>)}</div>
    <p className="doc-small">Production owns authentication/classification, durable inbox and thread stores, atomic claims/lease recovery, per-thread worker ownership, and waking a worker after a call has returned. Settlement/claim errors are not currently guaranteed to surface as run failures; instrument your adapter. MemoryInboxStore is single-process and not crash-durable. The interface alone is not exactly-once delivery.</p>
    <h3>Context, runtime facts, and continuation</h3>
    <p className="doc-small">Inbox delivery alone does not supply conversation persistence; pass <code>thread</code> with a stable ID. The SDK reuses the started sandbox within a chain. The current chain reuses run options but does not explicitly set the next run's startPhase from the preceding result; do not assume every phase label automatically carries. <code>result.usage</code> is cumulative; <code>result.runs</code> contains per-run usage deltas. Top-level evidence/messages/steps belong to the final run rather than an aggregate of every run.</p>
    <p className="doc-small"><code>origin: "runtime"</code> marks learned background results, which are retained by ThreadStore. <code>origin: "engine"</code> marks transient nudges, filtered from normal cross-run history. Neither is a secrecy flag; the origin marker is not sent to the model provider. Your strategy must consume application context, and your UI must deliberately filter what it displays.</p>
  </>;
}
