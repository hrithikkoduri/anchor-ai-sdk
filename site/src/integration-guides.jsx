import React from "react";
import * as Tabs from "@animate-ui/react/primitives/radix-ui/tabs";
import { CodeBlock } from "./ui.jsx";

export const customToolExample = `import { defineTool, requireString, optionalNumber, truncate } from "anchor-ai-sdk";

// Your app provides searchCatalog and enforces authorization for this tenant.
export function makeSearchCatalogTool(searchCatalog) {
  return defineTool(
    {
      name: "search_catalog",
      description: "Find up to 10 catalog entries by a text query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "What to find" },
          limit: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async (input) => {
      // The schema is not a runtime validator: check inputs in the handler.
      if (Object.keys(input).some(key => !["query", "limit"].includes(key))) {
        throw new Error("Unexpected parameter");
      }
      const query = requireString(input, "query").trim();
      if (input.limit !== undefined && typeof input.limit !== "number") {
        throw new Error("limit must be a number");
      }
      const limit = optionalNumber(input, "limit", 5);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new Error("limit must be an integer from 1 to 10");
      }
      const entries = await searchCatalog({ query, limit });
      return {
        ok: true,
        content: truncate(JSON.stringify(entries), { maxLines: 80, maxChars: 8_000 }),
        meta: { count: entries.length, query },
        verb: "Searching the catalog",
      };
    },
    { readOnly: true }, // only if this handler cannot mutate the workspace
  );
}`;

const sandboxToolExample = `import { defineTool, requireSandbox, truncate } from "anchor-ai-sdk";

export const nodeVersionTool = defineTool(
  {
    name: "node_version",
    description: "Read the Node.js version installed in the sandbox.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  async (input, ctx) => {
    if (Object.keys(input).length) throw new Error("No parameters expected");
    const sandbox = requireSandbox(ctx);
    const result = await sandbox.exec("node --version", {
      timeoutSecs: 30,
      concurrent: true, // read-only operation; do not set for mutations
    });
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      content: truncate(result.output),
      meta: { exitCode: result.exitCode, timedOut: result.timedOut },
    };
  },
  { readOnly: true, verb: "Checking sandbox Node version" },
);`;

export function ToolsGuide() {
  return (
    <>
      <p>
        A tool has a model-visible JSON Schema and a handler you write. Define
        the allowed inputs, validate them, do the authorized operation, then
        return text for the model and optional metadata for the journal.
      </p>
      <Tabs.Root defaultValue="api" className="custom-agent-tabs tools-config">
        <Tabs.List aria-label="Custom tool examples">
          <Tabs.Trigger value="api">API / application tool</Tabs.Trigger>
          <Tabs.Trigger value="sandbox">Sandbox-backed tool</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="api">
          <CodeBlock
            code={customToolExample}
            filename="catalog-tool.mjs"
            language="JAVASCRIPT"
          />
        </Tabs.Content>
        <Tabs.Content value="sandbox">
          <CodeBlock
            code={sandboxToolExample}
            filename="node-version-tool.mjs"
            language="JAVASCRIPT"
          />
        </Tabs.Content>
      </Tabs.Root>
      <p className="doc-small">
        <code>defineTool</code> catches thrown handler errors and returns{" "}
        <code>ok: false</code> with error text. It does not enforce the whole
        JSON Schema. The example validates required strings, number type/range,
        and unexpected keys itself; use your own schema validator if needed.{" "}
        <code>optionalNumber</code> can coerce values, so the strict type check
        above is deliberate.
      </p>
      <CodeBlock
        code={`import { chatAgent, codingAgent, runAgent } from "anchor-ai-sdk";
import { makeSearchCatalogTool } from "./catalog-tool.mjs";

// searchCatalog is your authorized application service, not an SDK export.
const searchCatalogTool = makeSearchCatalogTool(searchCatalog);

// A custom bundle, reusing the chat strategy:
const catalogAgent = {
  name: "catalog-assistant",
  strategy: chatAgent.strategy,
  tools: [searchCatalogTool],
};
await runAgent({ task: "Find the relevant catalog entries" }, {
  llm, agent: catalogAgent,
});

// Or extend a coding bundle. Explicit tools replace the bundle's list:
// tools: [...codingAgent.tools, searchCatalogTool],
// agent: codingAgent, sandbox,`}
        filename="attach-tools.mjs"
        language="JAVASCRIPT"
      />
      <div className="agent-interface-fields">
        {[
          [
            "definition.name / description / parameters",
            "The name the model calls, when it should use the capability, and the JSON Schema. Schema hints do not replace server-side authorization or validation.",
          ],
          [
            "run(input, ctx)",
            "Your async handler. It receives an input object and ToolContext, including an optional sandbox. Custom API tools need not use a machine. ToolContext does not currently supply an AbortSignal; add timeout/cancellation in your own service.",
          ],
          [
            "ok / content / meta",
            "ok is the handler’s operation status. content is the text sent to the model, already bounded by your tool. meta is structured trace/evidence data, not a model reply. The engine does not universally truncate arbitrary custom-tool output for you.",
          ],
          [
            "verb / readOnly",
            "A display label, and your assertion that the tool does not mutate the workspace. The engine may dispatch a fully read-only tool-call batch concurrently; flags do not prove handlers are safe.",
          ],
        ].map(([field, text]) => (
          <div key={field}>
            <code>{field}</code>
            <p>{text}</p>
          </div>
        ))}
      </div>
      <p className="doc-small">
        Keep credentials in the host/service or sandbox environment, not
        model-visible schemas or tool results. The built-in <code>finish</code>{" "}
        and multi-phase <code>set_phase</code> tools are added by the engine
        unless disabled; do not add duplicates to the capability array. Tool
        schemas do not themselves enforce phase policy.
      </p>
    </>
  );
}

const streamExample = `import { runAgent } from "anchor-ai-sdk";

// llm, agent, optional sandbox, and task come from your host setup.
const result = await runAgent({ task }, {
  llm, agent, sandbox,
  onEvent(event) {
    switch (event.type) {
      case "llm_text_delta":
        process.stdout.write(event.text);
        break;
      case "tool_call":
        console.error("tool:", event.name, event.callId, event.verb);
        break;
      case "tool_result":
        console.error("result:", event.name, event.ok, event.contentChars);
        // event.content and event.meta contain the detailed result.
        // Raw events are not redacted. Do not dump secrets into logs.
        break;
      case "advisory":
        console.error(event.kind, event.detail);
        break;
      case "run_finished":
        console.error("finished:", event.reason, event.usage);
        break;
    }
  },
});
// onEvent is synchronous/observational. Async handlers are not awaited.
// Avoid slow blocking I/O here; use traceSinks for serialized persistence.`;

const traceExample = `import { JsonlTrace, runAgent } from "anchor-ai-sdk";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const runId = randomUUID();
const trace = new JsonlTrace("./traces/" + runId + ".ndjson");
const result = await runAgent({ task }, {
  llm, agent, sandbox,
  traceSinks: [trace],
});

// Configured sinks are flushed before runAgent resolves.
const entries = (await readFile(trace.filePath, "utf8"))
  .trim().split("\\n").filter(Boolean).map(line => JSON.parse(line));
let segment = -1;
for (const { seq, ts, event } of entries) {
  if (event.type === "run_started") segment++;
  if (event.type === "llm_call_finished") {
    console.log(runId, segment, seq, ts, event.text, event.toolCalls, event.usage);
  }
  if (event.type === "tool_result") {
    console.log(runId, segment, seq, ts, event.name, event.content, event.meta);
  }
}
// Entries are { seq, ts, event }. A native inbox call can contain several runs.
// Each subrun restarts seq; derive a segment from run_started, not seq alone.
// Reasoning is included only when the provider returns it. Protect trace files.`;

const sinkExample = `import { runAgent } from "anchor-ai-sdk";

// saveEntry is your storage adapter. Persist full event JSON, not just its type.
export function databaseTraceSink(runId, saveEntry) {
  let segment = -1;
  return {
    name: "database",
    async record({ seq, ts, event }) {
      if (event.type === "run_started") segment++;
      await saveEntry({ runId, segment, seq, ts, type: event.type, payload: event });
    },
  };
}

// Your app must implement saveEntry and access control/retention policies.
await runAgent({ task }, {
  llm, agent, sandbox,
  traceSinks: [databaseTraceSink(runId, saveEntry)],
});
// Engine fanout sequences and pattern-redacts entries before the sink.
// Use (runId, segment, seq) for chain records: seq restarts on each subrun.
// Create a fresh sink/runId for each public runAgent invocation.`;

const uiStreamExample = `import { createLiveProjector, JsonlTrace, runAgent } from "anchor-ai-sdk";

// Framework-neutral: send(payload) writes an SSE or websocket frame in your app.
export async function runForUi({ llm, agent, sandbox, task, runId, send, signal, inbox }) {
  let segment = -1;
  const live = createLiveProjector(frame => {
    if (frame.kind === "started") segment++;
    send({ runId, segment, ...frame });
  });
  const result = await runAgent({ task }, {
    llm, agent, sandbox, signal, inbox,
    traceSinks: [new JsonlTrace("./traces/" + runId + ".ndjson"), live],
  });
  send({ kind: "execution_finished", runId, reason: result.reason });
  return result;
}
// Example app-owned SSE writer:
// send = payload => response.write("data: " + JSON.stringify(payload) + "\\n\\n");
// Set SSE response headers, authenticate the connection, wire disconnects to
// an AbortController, and handle backpressure in your framework.
// Delta frames are cumulative for the current model step: replace, don't append.
// With an inbox, run_finished is per subrun. Keep the connection open until
// runAgent resolves (or your endpoint handles an exception), not the first finish.
// The live projector truncates tool-result content to 4,000 characters.
// Persist the full engine event separately if you need detailed replay.`;

export function StreamingGuide() {
  return (
    <>
      <p>
        Use <code>onEvent</code> for immediate text/status updates and{" "}
        <code>traceSinks</code> for sequenced records. Both can be attached to
        the same run. The host supplies the configured model, agent, task, and
        any sandbox used by these snippets.
      </p>
      <Tabs.Root
        defaultValue="stream"
        className="custom-agent-tabs trace-config"
      >
        <Tabs.List aria-label="Streaming and trace examples">
          {[
            ["stream", "Live events"],
            ["file", "NDJSON"],
            ["sink", "Custom sink"],
            ["ui", "UI stream"],
          ].map(([id, label]) => (
            <Tabs.Trigger key={id} value={id}>
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {[
          ["stream", streamExample],
          ["file", traceExample],
          ["sink", sinkExample],
          ["ui", uiStreamExample],
        ].map(([id, code]) => (
          <Tabs.Content key={id} value={id}>
            <CodeBlock
              code={code}
              filename={`${id}-trace.mjs`}
              language="JAVASCRIPT"
            />
          </Tabs.Content>
        ))}
      </Tabs.Root>
      <div className="agent-interface-fields">
        {[
          [
            "llm_call_finished",
            "Full assistant text for the turn, provider-returned reasoning if present, tool-call arguments, usage, latency, and model/provider identity when supplied. This is not a packet capture of the HTTP exchange or the full input prompt.",
          ],
          [
            "tool_call / tool_result",
            "Inputs and call ID on the call; model-facing bounded result content and structured meta on the result. Built-in spilled outputs are pointers to sandbox files, not copies of every byte in the journal.",
          ],
          [
            "compacted / checkpoint / revival_requested",
            "Fold summary and bounded folding preview, checkpoint references/push status, and the model’s optional remaining-work request. Relevant events appear only when that feature/path runs.",
          ],
          [
            "onEvent vs traceSinks",
            "onEvent receives raw events and is not an async persistence hook. Sinks receive { seq, ts, event } after pattern redaction and are serialized per sink. Redaction is not guaranteed to detect every secret; audit sensitive data before sharing.",
          ],
          [
            "background and inbox events",
            "background_started/completed and inbox_interject/delivered are engine events. The current live projector does not emit dedicated frames for those cases. Record them in a custom/full sink or handle selected metadata in onEvent. background_completed does not contain the full background result body; runtime facts live in conversation state.",
          ],
        ].map(([field, text]) => (
          <div key={field}>
            <code>{field}</code>
            <p>{text}</p>
          </div>
        ))}
      </div>
      <CodeBlock
        code={`import { projectConversation } from "anchor-ai-sdk";

// Split a chain journal into run segments before replaying step-scoped content.
const segments = [];
for (const entry of entries) {
  if (entry.event.type === "run_started" || segments.length === 0) segments.push([]);
  segments.at(-1).push(entry);
}
const replays = segments.map(segment => {
  const finished = segment.findLast(entry => entry.event.type === "run_finished");
  return projectConversation(segment.map(({ seq, event }) => ({
    seq, type: event.type, payload: event,
  })), finished?.event.reason ?? "running");
});
// Feed records in stored order. seq/step alone are not chain-wide identifiers.
// Reconnection transport, event storage queries, and client UI are app-owned.`}
        filename="replay-trace.mjs"
        language="JAVASCRIPT"
      />
      <p className="doc-small">
        The built-in client streams; provider-reported reasoning may be absent.
        Sink exceptions are isolated, but a never-settling sink can delay flush.
        Configure sinks before the run if you need a journal. Filesystem storage
        in a short-lived/serverless host may be ephemeral; use your own durable
        sink where required.
      </p>
    </>
  );
}
