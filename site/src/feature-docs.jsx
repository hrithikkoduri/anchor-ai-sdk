import React from "react";
import { CodeBlock, repo } from "./ui.jsx";

// Kept separate from the quickstart so release-specific instructions stay
// readable without pulling provider SDKs into the static documentation app.
export function FeatureDocs({ Section, Callout }) {
  return <>
    <Section id="verification" number="16" title="Ledger & verification">
      <p>Opt into task verification with <code>verifier</code>. Anchor compiles
        the request into an append-only progress ledger, captures tool-result
        evidence, and checks requirement coverage at phase and finish boundaries.
        It adds <code>update_ledger</code> to the task toolbox; you do not need a new storage service.</p>
      <CodeBlock filename="verified-run.ts" code={`// llm and sandbox are configured and started by your app.
const result = await runAgent(
  { task: "Fix the retry bug and add a regression test" },
  {
    llm, sandbox, agent: codingAgent,
    verifier: { onError: "block", maxCallsPerTask: 6 },
    thread: { store: threadStore, id: "retry-fix" },
  },
);
console.log(result.ledger, result.evidence);`} />
      <p>Locked source requirements cannot be deleted or weakened by the agent.
        Tool results become evidence references; marking a requirement verified
        requires linked evidence. A separate structured model call judges whether
        that evidence supports the claim. The compiler and verifier consume the run budget.</p>
      <Callout><code>verifier: true</code> uses the run model for separate checks.
        Supply <code>verifier.llm</code> for a different client. Default outage
        behavior is allow-with-warning; the example uses <code>onError: "block"</code>.
        This is a guard against unsupported completion, not proof of correctness.</Callout>
      <p>The ledger lives on <code>StoredThread</code>. Provide a durable
        <code>ThreadStore</code> in production. Intent routing distinguishes tasks
        from conversation; chat turns do not create a task ledger or make verifier calls.</p>
    </Section>

    <Section id="structured-output" number="17" title="Structured output">
      <p><code>LLMRequest.responseFormat</code> carries a schema-bound response
        request. <code>completeStructured</code> parses and validates the result;
        the task compiler and alignment verifier use it instead of scraping prose.</p>
      <p>Provider schema support varies. Inspect errors and provide explicit
        validation rather than assuming that a JSON-shaped response is trustworthy.</p>
      <CodeBlock filename="structured-output.ts" code={`import { completeStructured } from "anchor-ai-sdk";

const { value } = await completeStructured(llm, {
  name: "decision",
  messages: [{ role: "user", content: "Should this retry? Answer with retry." }],
  schema: {
    type: "object", properties: { retry: { type: "boolean" } },
    required: ["retry"], additionalProperties: false,
  },
  parse(value) {
    if (!value || typeof value !== "object" ||
        !("retry" in value) || typeof value.retry !== "boolean") {
      throw new Error("Expected a boolean retry field");
    }
    return { retry: value.retry };
  },
});`} />
      <a className="doc-inline-link" href={`${repo}/blob/main/src/llm/structured.ts`}>Structured client API ↗</a>
    </Section>

    <Section id="operations" number="18" title="External-effect recovery">
      <p>A crash after a payment, ticket creation, or API write must not turn an
        unknown outcome into a second write. Tools can declare an <code>effect</code>
        and use <code>ctx.operationId</code> as the target's idempotency key.</p>
      <CodeBlock filename="operation-options.ts" code={`// Inside runAgent(task, options):
operations: { store: operationStore },

// In an effectful tool handler:
// await target.write(input, { idempotencyKey: ctx.operationId });
// await ctx.acknowledge?.({ jobId: acceptedJobId });`} />
      <p>On resume, the tool's <code>effect.reconcile</code> reports applied,
        not applied, or unknown. Unknown stops the run with
        <code>reason: "recovery_required"</code> and pending operations rather
        than replaying blindly. <code>MemoryOperationStore</code> is for tests;
        production needs durable writes and unique operation IDs.</p>
      <Callout>The target must honor idempotency or expose a reliable status
        lookup. An operation journal alone cannot guarantee exactly-once effects.</Callout>
    </Section>

    <Section id="process-streams" number="19" title="Persistent processes">
      <p><code>exec()</code> waits for a one-shot command. Optional
        <code>openProcess(command, args, options)</code> keeps a process alive
        with stdin/stdout/stderr for REPLs, watchers, servers, and LSP clients.</p>
      <CodeBlock filename="process.ts" code={`if (!provider.capabilities.processStream || !sandbox.openProcess) {
  throw new Error("This provider does not support process streams");
}
const proc = await sandbox.openProcess("cat", [], {
  cwd: sandbox.workspace, timeoutSecs: 60,
});
const output = (async () => {
  for await (const bytes of proc.stdout) {
    process.stdout.write(bytes);
  }
})();
await proc.write("hello\\n");
await proc.endInput();
await Promise.all([output, proc.wait()]);`} />
      <p><code>ProcessOptions.signal</code> and a lifetime deadline terminate
        the process. <code>kill()</code> is explicit; sandbox destruction closes
        tracked streams. Providers currently cap each sandbox at eight processes.</p>
      <Callout>Local uses host pipes; Docker uses <code>docker exec -i</code>;
        E2B uses native background-command stdin. Heyo uses a PTY: stderr is
        merged, EOF is Ctrl-D, and there is no transport drain signal. These
        are not equivalent byte-stream guarantees. One-shot <code>exec()</code>
        cancellation from PR #9 was not merged.</Callout>
    </Section>

    <Section id="image-publishing" number="20" title="Publish sandbox images">
      <p>Publish once, then select the environment when creating the sandbox.
        <code>ImagePublisher</code> is a common interface over provider-native
        stores, not an Anchor registry. Check <code>capabilities.publishImage</code>
        and <code>provider.imagePublisher.sources</code> before building.</p>
      <CodeBlock filename="publish.sh" language="SHELL" code={`# Use an installed anchor binary, or: npx --package=anchor-ai-sdk@0.1.8 anchor ...
anchor image publish --provider docker --name ghcr.io/acme/agent:v1 \\
  --dockerfile Dockerfile --context .

anchor e2b image publish --name acme-agent:v1 --from-image ubuntu:24.04

anchor heyo image publish --name acme/agent:v1 --rootfs ./rootfs.ext4

# Add --json to a publish command for a machine-readable result.
anchor image publish --help`} />
      <div className="doc-facts">
        <div><strong>Docker</strong><p>Requires the Docker CLI, daemon, and registry
          login. Build/tag then push; <code>--no-push</code> builds locally.
          Set <code>ANCHOR_DOCKER_BIN</code> or <code>DOCKER_BIN</code> if needed.</p></div>
        <div><strong>E2B</strong><p>Install <code>e2b</code> and set
          <code>E2B_API_KEY</code>. The result is a template. Separate
          <code>--context</code> and <code>--no-push</code> are rejected.
          Build a container first when your Dockerfile needs local COPY files.</p></div>
        <div><strong>Heyo</strong><p>Requires an installed and logged-in
          <code>heyctl</code> (published builds: Linux x86_64). Set
          <code>HEYCTL_BIN</code> if needed. Rootfs and Dockerfile-manifest
          sources return provider configuration.</p></div>
      </div>
      <CodeBlock filename="published-image.ts" code={`const published = await provider.imagePublisher.publish({
  name: "ghcr.io/acme/agent:v1",
  source: { kind: "dockerfile", path: "Dockerfile", context: "." },
});
if (published.target === "sandbox-spec") {
  const sandbox = provider.create({ image: published.ref });
}
// For target: "provider-config", merge published.providerConfig into
// the provider factory. Keep credentials in the host, not in this object.`} />
      <p><code>spec.image</code> overrides Docker images and E2B template names.
        Heyo accepts an artifact ref only when configured with
        <code>imageKind: "artifact"</code>; Dockerfile/git builds use provider
        configuration. Local has no image. Daytona is not implemented.</p>
      <Callout>Contract tests use fake runners; live registry publication has
        not been verified here. Authentication, platform binaries, network,
        image compatibility, and provider quotas can still fail. Additional
        providers can implement <code>ImagePublisher</code> programmatically;
        the built-in CLI currently selects Docker, E2B, or Heyo.</Callout>
      <a className="doc-inline-link" href={`${repo}/blob/main/docs/sandbox-image-publishing.md`}>Provider instructions &amp; troubleshooting ↗</a>
    </Section>

    <Section id="lsp" number="21" title="Optional TypeScript LSP">
      <p><code>anchor-ai-sdk/lsp</code> adds four read-only tools:
        <code>lsp_diagnostics</code>, <code>lsp_definition</code>,
        <code>lsp_references</code>, and <code>lsp_symbols</code>.
        The optional entry point owns JSON-RPC/LSP; core only knows process streams.</p>
      <CodeBlock filename="lsp-agent.ts" code={`import { createCodingAgent } from "anchor-ai-sdk";
import { createLspTools } from "anchor-ai-sdk/lsp";

const base = createCodingAgent();
const agent = { ...base, tools: [...base.tools, ...createLspTools()] };
// Pass agent to runAgent with your configured model and sandbox.
// Bake into the sandbox image:
// npm install -g typescript typescript-language-server`} />
      <p>Tools accept 1-based lines/columns and currently support TypeScript
        and JavaScript only. The server must already exist in the sandbox;
        nothing is installed automatically. Keep search/read_file as the fallback:
        missing-server errors do not transparently invoke another tool.</p>
      <Callout>The protocol/client was tested over LocalSandbox with a fixture
        server, not a live TypeScript server on every cloud provider. Prefer a
        pipe-backed transport for LSP. Heyo's PTY raw-byte behavior is unverified.
        Consumers choose the command, when to start it, and its lifecycle.</Callout>
      <a className="doc-inline-link" href={`${repo}/blob/main/docs/lsp.md`}>Direct client and lifecycle guide ↗</a>
    </Section>

    <Section id="philosophy" number="22" title="Mechanics, not product policy">
      <p>Keep the model loop small and its decisions inspectable. Requirements
        should survive the conversation, evidence should be distinguishable from
        claims, and uncertain external effects should not be replayed as guesses.</p>
      <p>Anchor supplies contracts: tools, stores, budgets, evidence, recovery,
        and provider adapters. Your application owns permission to act, secrets,
        durable storage, model selection, and permission to publish. Optional
        features stay optional; a chat agent need not boot a machine or compile a ledger.</p>
      <p>Capabilities are promises to test, not interchangeable provider names.
        Filesystem plus git is the repository's durable state; the ledger tracks
        obligations, not a replacement memory database. No graph memory, agent
        teams, or performance claim is implied by adding more infrastructure.</p>
      <a className="doc-inline-link" href="/changelog.html">Follow the release timeline ↗</a>
    </Section>
  </>;
}
