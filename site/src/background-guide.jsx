import React from "react";
import * as Tabs from "@animate-ui/react/primitives/radix-ui/tabs";
import { Download } from "lucide-react";
import { CodeBlock, CopyButton } from "./ui.jsx";
import customToolSource from "./examples/background-tool.mjs?raw";

const enableExample = `import { codingAgent, runAgent } from "anchor-ai-sdk";

// sandbox is a STARTED Heyo sandbox from the provider setup section.
const result = await runAgent({ task: "Run checks and inspect related files" }, {
  llm, agent: codingAgent, sandbox,
  thread: { store: threadStore, id: "repo-42" },
  backgroundAfterSecs: 15,
  onEvent(event) {
    if (event.type === "background_started") {
      console.log("launched", event.jobId, event.tool, event.timeoutSecs);
    }
    if (event.type === "background_completed") {
      console.log("finished", event.jobId, event.exitCode, event.timedOut);
    }
  },
});
// bash is already background-enabled. A shorter/equal explicit command deadline
// stays synchronous. Detach is an accepted launch, not successful completion.`;

const attachExample = `import { codingAgent, runAgent } from "anchor-ai-sdk";
import { projectChecksTool } from "./background-tool.mjs";

const result = await runAgent({ task: "Run project_checks and report its result" }, {
  llm, agent: codingAgent, sandbox,
  tools: [...codingAgent.tools, projectChecksTool],
  backgroundAfterSecs: 15,
});
// Merely adding background: true to a copied tool object is not sufficient.
// defineTool captures its options; the handler must support detach and metadata.`;

const resumeExample = `// Store these before the worker/process exits. Callbacks are app-owned.
await persistContinuation({
  threadId,
  handle: { id: sandbox.id, backend: sandbox.backend },
  pendingJobs: result.pendingJobs ?? [],
});

// In a later worker, restore/adopt the retained machine before resuming:
const continuation = await loadContinuation(threadId);
const adopted = provider.adopt(continuation.handle, { retain: true });
await adopted.start();
const next = await runAgent({ task: "Continue and report the pending command" }, {
  llm, agent, sandbox: adopted,
  thread: { store: durableThreadStore, id: threadId },
  resumeJobs: continuation.pendingJobs,
  backgroundAfterSecs: 15,
});
// Persist any remaining jobs again. Your worker/sweeper owns wake-up and cleanup.
// Do not release/park a live job prematurely. Heyo destroy() can defer parking.
// Later: await adopted.killJob(jobId) if host policy chooses to cancel that job.`;

const directExample = `// Direct Sandbox API, WITHOUT runAgent owning this job:
const startedAt = Date.now();
const result = await sandbox.exec("npm test", {
  timeoutSecs: 600,
  backgroundAfterSecs: 15,
});
if (result.background) {
  const jobId = result.background.jobId;
  // One observation. undefined means still running; schedule another later.
  const finished = await sandbox.pollJob(jobId, { startedAt, timeoutSecs: 600 });
  if (finished) console.log(finished.exitCode, finished.output);
  // Or await sandbox.killJob(jobId) from your cleanup/cancel policy.
}
// This low-level path needs pollJob support. Do not double-poll a job that
// runAgent already owns: a provider may reap the receipt on delivery.`;

export function BackgroundGuide() {
  return <>
    <p>Heyo currently provides the <code>pollJob</code>/<code>killJob</code> implementation used by background delivery. Any custom <strong>sandbox-exec</strong> tool can wire the opt-in contract; arbitrary host-side promises and all existing tools do not become backgroundable automatically. Built-in <code>bash</code> is enabled; built-in <code>run_tests</code> remains synchronous in 0.1.7.</p>
    <Tabs.Root defaultValue="enable" className="custom-agent-tabs background-config"><Tabs.List aria-label="Background execution examples">{[["enable", "Enable"], ["tool", "Custom tool"], ["resume", "Resume jobs"], ["direct", "Direct sandbox"]].map(([id, label]) => <Tabs.Trigger value={id} key={id}>{label}</Tabs.Trigger>)}</Tabs.List>{[["enable", enableExample], ["tool", customToolSource], ["resume", resumeExample], ["direct", directExample]].map(([id, code]) => <Tabs.Content key={id} value={id}><CodeBlock code={code} filename={`${id}-background.mjs`} language="JAVASCRIPT" /></Tabs.Content>)}</Tabs.Root>
    <div className="agent-example-download"><span>Custom tool using only public 0.1.7 exports.</span><CopyButton text={customToolSource} label="Copy background-capable tool" /><a href={`data:text/javascript;charset=utf-8,${encodeURIComponent(customToolSource)}`} download="background-tool.mjs">Download tool <Download size={14} /></a></div>
    <CodeBlock code={attachExample} filename="attach-background-tool.mjs" language="JAVASCRIPT" />
    <div className="agent-interface-fields">{[
      ["Tool permission", "Declare { background: true } in defineTool options. The wrapper exposes that permission as ctx.backgroundAllowed. Its handler must pass backgroundAfterSecs to sandbox.exec and return meta.background, command and timeoutSecs on detach."],
      ["Consumer threshold + provider support", "Set a positive backgroundAfterSecs in run options; an unset value is synchronous. The provider needs pollJob. Tools/adapters without support stay synchronous or follow their documented behavior; do not rely on Docker/E2B/local detachment in this release."],
      ["Detach threshold ≠ deadline", "The command must be permitted to outlive the threshold. Bash uses the explicit deadline or an eligible background lifetime up to 3,600s. A deadline at/below the threshold does not detach. The custom example chooses a 600s hard lifetime; the threshold does not extend it."],
      ["Engine-owned delivery", "The dispatcher records handles, the engine polls before model turns and before normal finish, and completed output is injected as a runtime fact. Before a normal finish it waits within job deadline/grace logic unless the optional inbox hasPending indicates waiting work."],
      ["Across an inbox chain", "Outstanding jobs carry automatically into the next run. Interjections take precedence at the boundary, and queued work can avoid a forced pre-finish wait when hasPending is implemented. A shared budget or cancellation may still end the chain with pendingJobs."],
    ].map(([title, text]) => <div key={title}><code>{title}</code><p>{text}</p></div>)}</div>
    <p className="doc-small">Interjecting does not kill a guest command or undo its writes. Detached jobs can mutate the same workspace while later tools run; choose safe workloads and cancel conflicting work explicitly. Heyo marks retention on detach and may defer destroy/parking while jobs remain, so the host must persist handles, wake later work, and enforce a cleanup policy.</p>
    <p className="doc-small">Delivered bodies use the normal best-effort truncate/spill path and <code>origin: "runtime"</code>, so facts survive in a supplied thread store until later compaction. <code>background_completed</code> reports job/status metadata, not the full output body. Use conversation/runtime state and retained spill files where available; the event journal alone is not a byte-for-byte archive of every background result.</p>
  </>;
}
