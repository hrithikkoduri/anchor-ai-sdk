import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Collapsible from "@animate-ui/react/primitives/radix-ui/collapsible";
import * as Accordion from "@animate-ui/react/primitives/radix-ui/accordion";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  Check,
  Command,
  Folder,
  GitBranch,
  HeartPulse,
  Link,
  Plus,
  ShieldCheck,
  Terminal,
  Workflow,
} from "lucide-react";
import { CodeBlock, CopyButton, PageShell, repo } from "./ui.jsx";
import { CustomAgentExample } from "./agent-example.jsx";
import { FeatureDocs } from "./feature-docs.jsx";
import { ConsumerDocs } from "./consumer-docs.jsx";
import "./styles.css";
import "./pages.css";
import "./typography.css";
import "./theme.css";

const groups = [
  [
    "GET STARTED",
    [
      ["install", "Install"],
      ["quickstart", "Your first agent"],
      ["custom-agents", "Custom agents"],
      ["machine", "Give it a machine"],
    ],
  ],
  [
    "THE HARNESS",
    [
      ["engine", "Loop & budgets"],
      ["prompt-caching", "Prompt caching"],
      ["composition", "Composition helpers"],
      ["correction", "Course correction"],
      ["memory", "Filesystem memory"],
      ["revival", "Revival & resume"],
      ["evidence", "Evidence"],
      ["verification", "Task contracts & judge"],
      ["structured-output", "Structured output"],
      ["operations", "External-effect recovery"],
      ["traces", "Streaming & traces"],
    ],
  ],
  [
    "BUILD ON IT",
    [
      ["providers", "Sandbox providers"],
      ["contract", "The contract"],
      ["conformance", "Conformance"],
      ["tools", "Tools & strategies"],
      ["thread-store", "Thread store"],
      ["inbox-store", "Inbox store"],
      ["operation-store", "Operation store"],
      ["sandbox-store", "Sandbox store"],
      ["compaction-contract", "Compaction handoff"],
      ["process-streams", "Persistent processes"],
      ["images", "Image context"],
      ["preview-ports", "Preview ports"],
      ["image-publishing", "Publish sandbox images"],
      ["lsp", "Optional LSP tools"],
      ["philosophy", "Philosophy"],
      ["testing", "Testing"],
      ["status", "Status & versioning"],
    ],
  ],
];
const chat = `import { chatAgent, llmFromCatalog, runAgent } from "anchor-ai-sdk";

const { llm, compaction } = await llmFromCatalog({
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_KEY,
  model: "z-ai/glm-5.3",
});

const result = await runAgent(
  { task: "Explain exponential backoff in plain English" },
  { llm, compaction, agent: chatAgent },
);

console.log(result.summary);`;
const machine = `import { codingAgent, llmFromCatalog, runAgent } from "anchor-ai-sdk";
import { docker } from "anchor-ai-sdk/sandbox/docker";

const { llm, compaction } = await llmFromCatalog({
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_KEY,
  model: "z-ai/glm-5.3",
});

// Use an image containing bash, git, coreutils, and your repo's toolchain.
const sandbox = docker({ image: "your-registry/agent-toolchain:v1" }).create({
  repoUrl: "https://github.com/you/your-repo",
  ref: "main",
});
await sandbox.start();

try {
  const result = await runAgent(
    { task: "Run the tests and fix the failing case" },
    { llm, compaction, agent: codingAgent, sandbox },
  );
  console.log(result.summary, result.checkpointRef);
} finally {
  await sandbox.destroy();
}`;

function DocSection({ id, number, title, children }) {
  return (
    <section
      id={id}
      className="doc-section"
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
    >
      <div className="doc-section-title">
        <span>{number}</span>
        <h2 id={`${id}-title`}>{title}</h2>
        <a href={`#${id}`} aria-label={`Link to ${title}`}>
          <Link size={14} />
        </a>
      </div>
      {children}
    </section>
  );
}

function Callout({ children, icon: Icon = Command }) {
  return (
    <div className="doc-callout">
      <Icon size={16} />
      <div>{children}</div>
    </div>
  );
}

function Docs() {
  const [active, setActive] = useState("install");
  const [open, setOpen] = useState(false);
  const [pendingSection, setPendingSection] = useState(null);
  const mobileContents = useRef(null);
  useEffect(() => {
    if (!pendingSection || !mobileContents.current) return;
    // Anchor only after the animated contents has left the layout. Otherwise
    // its collapsing height moves the destination after native hash scrolling.
    function navigateWhenClosed() {
      if (mobileContents.current?.querySelector("nav")) return;
      observer.disconnect();
      const target = document.getElementById(pendingSection);
      if (target) {
        target.focus({ preventScroll: true });
        if (location.hash !== `#${pendingSection}`) {
          history.pushState(null, "", `#${pendingSection}`);
        }
        target.scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "instant"
            : "smooth",
        });
      }
      setPendingSection(null);
    }
    const observer = new MutationObserver(navigateWhenClosed);
    observer.observe(mobileContents.current, {
      childList: true,
      subtree: true,
    });
    navigateWhenClosed();
    return () => observer.disconnect();
  }, [pendingSection]);
  useEffect(() => {
    function update() {
      const sections = [...document.querySelectorAll(".doc-section")];
      const current = sections
        .filter((section) => section.getBoundingClientRect().top <= 160)
        .at(-1);
      setActive(current?.id ?? "install");
    }
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(
        decodeURIComponent(location.hash.slice(1)),
      );
      if (target) target.scrollIntoView({ behavior: "instant" });
      update();
    });
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
    };
  }, []);
  function contents(mobile = false) {
    return groups.map(([name, items]) => (
      <div className="doc-nav-group" key={name}>
        <span>{name}</span>
        {items.map(([id, title]) => (
          <a
            key={id}
            href={`#${id}`}
            aria-current={active === id ? "location" : undefined}
            onClick={(event) => {
              if (
                !mobile ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              setPendingSection(id);
              setOpen(false);
            }}
          >
            {title}
            {active === id && <span className="status-dot" />}
          </a>
        ))}
      </div>
    ));
  }
  return (
    <PageShell page="docs">
      <div className="container docs-layout">
        <aside className="doc-sidebar">
          <div className="doc-sidebar-label">
            <BookOpen size={14} /> DOCUMENTATION
          </div>
          <nav aria-label="Documentation sections">{contents()}</nav>
          <a className="sidebar-source" href={`${repo}/tree/main/src`}>
            Read the source <ArrowUpRight size={12} />
          </a>
        </aside>
        <div className="doc-article">
          <div className="doc-mobile-contents" ref={mobileContents}>
            <Collapsible.Root
              open={open}
              onOpenChange={(value) => {
                setOpen(value);
                if (value) setPendingSection(null);
              }}
            >
              <Collapsible.Trigger className="doc-contents-trigger">
                <BookOpen size={14} /> On this page <ChevronDown size={14} />
              </Collapsible.Trigger>
              <Collapsible.Content>
                <nav aria-label="Documentation sections mobile">
                  {contents(true)}
                </nav>
              </Collapsible.Content>
            </Collapsible.Root>
          </div>
          <header className="doc-intro">
            <h1>Quickstart</h1>
            <p>
              Install Anchor and run your first agent. Customize its behavior
              and tools in the sections below.
            </p>
            <div className="doc-meta">
              <span>Node 20+</span>
              <span>ESM</span>
              <span>SDK v0.5.0</span>
              <span>Provider API key required</span>
            </div>
          </header>

          <DocSection id="install" number="01" title="Install">
            <div className="doc-install">
              <Terminal size={16} />
              <code>npm install anchor-ai-sdk</code>
              <CopyButton
                text="npm install anchor-ai-sdk"
                label="Copy install command"
              />
            </div>
          </DocSection>

          <DocSection id="quickstart" number="02" title="Your first agent">
            <p>
              No sandbox needed. Configure an OpenAI-compatible model, hand it a
              task, and read the result.
            </p>
            <CodeBlock code={chat} filename="chat.mjs" language="JAVASCRIPT" />
            <p className="doc-small">
              Save the file as <code>chat.mjs</code>, then set your provider key
              and run it. Model calls may incur cost.
            </p>
            <CodeBlock
              code={`export OPENROUTER_KEY="your-key"\nnode chat.mjs`}
              filename="terminal"
              language="SHELL"
            />
            <div className="doc-result">
              <span className="eyebrow">WHAT COMES BACK</span>
              <div>
                <code>summary</code>
                <span>The agent’s answer</span>
                <code>evidence</code>
                <span>Structured tool results</span>
                <code>usage</code>
                <span>Tokens and known cost</span>
                <code>reason</code>
                <span>Why the run ended</span>
              </div>
            </div>
            <p className="doc-small">
              <code>llmFromCatalog</code> reads live pricing and the real
              context window. Pass its <code>compaction</code> configuration
              into the engine, as above. Metadata failures fall back rather than
              breaking the run.
            </p>
          </DocSection>

          <DocSection
            id="custom-agents"
            number="03"
            title="Build your own agent"
          >
            <CustomAgentExample />
          </DocSection>

          <DocSection id="machine" number="04" title="Give it a machine">
            <p>
              The coding bundle adds shell, file, search, and test tools. Start
              a Docker sandbox, pass it to the run, and clean up when you’re
              done.
            </p>
            <CodeBlock
              code={machine}
              filename="coding-agent.mjs"
              language="JAVASCRIPT"
            />
            <Callout icon={Terminal}>
              Requires a running Docker daemon. Replace the example repository
              with your own. Use the Heyo adapter for Firecracker microVMs;
              local execution is <strong>not isolated</strong>.
            </Callout>
            <a className="doc-inline-link" href={`${repo}/tree/main/examples`}>
              More runnable examples <ArrowUpRight size={13} />
            </a>
          </DocSection>

          <DocSection id="engine" number="05" title="Loop & budgets">
            <p>
              Model → tools → observations → model. Phases describe the
              approach, not permissions. The agent can skip, revisit, or finish
              from any phase.
            </p>
            <div className="phase-strip" aria-label="Default coding phases">
              {["understand", "plan", "act", "validate", "respond"].map(
                (phase, i) => (
                  <React.Fragment key={phase}>
                    <span>{phase}</span>
                    {i < 4 && <ArrowRight size={11} />}
                  </React.Fragment>
                ),
              )}
            </div>
            <div className="budget-strip">
              <div>
                <strong>40</strong>
                <span>STEPS / RUN</span>
              </div>
              <div>
                <strong>3M</strong>
                <span>TOKENS / RUN</span>
              </div>
              <div>
                <strong>$5</strong>
                <span>KNOWN COST / RUN</span>
              </div>
            </div>
            <p className="doc-small">
              These are defaults, not hard-coded policy. Override{" "}
              <code>budgets</code> per run. Dollar checks require usable
              pricing; step and token limits still apply without it.
            </p>
            <CodeBlock
              code={`// Inside runAgent(task, options):\nbudgets: { maxSteps: 60, maxTokens: 3_000_000, maxUsd: 3 },\nsampling: { temperature: 0, seed: 42 },`}
              filename="run-options.ts"
            />
            <p className="doc-small">
              Sampling is optional; an unset field uses the provider’s default.{" "}
              <code>set_phase</code> keeps the phase label current. Use{" "}
              <code>pauseAfterPhase</code> and <code>startPhase</code> for
              controlled pauses and resume.
            </p>
            <p className="doc-small"><code>reasoningEffort</code> can be set on
              a run or an agent bundle when the model supports it. It is not
              automatic per-phase model routing.</p>
          </DocSection>

          <DocSection id="correction" number="06" title="Course correction">
            <p>
              A bad turn needn’t waste a good run. The engine can redirect
              repeated calls, empty turns, nudge-triggered status replies, and a
              capped prose turn before giving up.
            </p>
            <div className="doc-flow">
              <div>
                <span>01 / DETECT</span>
                <strong>Something is stuck.</strong>
              </div>
              <ArrowRight size={15} />
              <div>
                <span>02 / REDIRECT</span>
                <strong>One clear advisory.</strong>
              </div>
              <ArrowRight size={15} />
              <div>
                <span>03 / CONTINUE</span>
                <strong>A bounded next chance.</strong>
              </div>
            </div>
            <Accordion.Root
              type="single"
              collapsible
              className="faq doc-accordion"
            >
              {[
                [
                  "Budgets and output caps",
                  "Run budgets bound steps, tokens, and known dollars. maxOutputTokens bounds a single generation (16k by default). A capped prose turn can continue once; repeated truncation can still stall the run.",
                ],
                [
                  "Repetition, silence, and verbosity",
                  "Repeated identical tool calls trigger at a default limit of 3. The silent-tool nudge fires after 8 consecutive tool-only turns; the verbose-turn nudge at 8k output tokens. Nudges guide the next turn, not authorize work.",
                ],
                [
                  "Prose checkpoints and switches",
                  "With the finish intrinsic available, prose that directly follows an engine nudge is checked once before it is treated as the answer. guardrails.proseCheckpoint turns this off. Threshold guardrails and maxOutputTokens accept false to disable them.",
                ],
              ].map(([title, body]) => (
                <Accordion.Item value={title} key={title}>
                  <Accordion.Header>
                    <Accordion.Trigger>
                      {title}
                      <Plus size={16} />
                    </Accordion.Trigger>
                  </Accordion.Header>
                  <Accordion.Content>
                    <p>{body}</p>
                  </Accordion.Content>
                </Accordion.Item>
              ))}
            </Accordion.Root>
          </DocSection>

          <DocSection id="memory" number="07" title="Filesystem memory">
            <p>
              Three layers keep a long-running agent oriented without replaying
              everything it has ever seen.
            </p>
            <div className="memory-layers">
              <div>
                <Folder size={18} />
                <div>
                  <h3>Notes on disk</h3>
                  <p>
                    <code>.anchor/notes.md</code> is git-excluded from normal
                    diffs and carried in checkpoints. Compaction doesn’t rewrite
                    the file.
                  </p>
                </div>
              </div>
              <div>
                <Command size={18} />
                <div>
                  <h3>Conversation across runs</h3>
                  <p>
                    <code>ThreadStore</code> carries the summary, recent
                    messages, and phase. <code>MemoryThreadStore</code> is the
                    in-memory default for development; durable storage is yours
                    to provide.
                  </p>
                </div>
              </div>
              <div>
                <Terminal size={18} />
                <div>
                  <h3>Spill, don’t discard</h3>
                  <p>
                    Oversized tool output is clipped (300 lines / 20k
                    characters) and spilled to sandbox storage when available.
                    Read it in slices or search the full file.
                  </p>
                </div>
              </div>
            </div>
            <Callout>
              Assistant-text elision bounds the model’s replay,{" "}
              <strong>not the stored transcript</strong>: 20k characters per
              reply by default, or 12k head-only for a capped reply. Full-text
              spills require sandbox scratch storage.
            </Callout>
          </DocSection>

          <DocSection id="revival" number="08" title="Revival & resume">
            <p>
              When budget runs low, preserve the handoff — not just the failure.
              Revival is opt-in, and funding stays in your app.
            </p>
            <div className="revival-diagram">
              <div>
                <HeartPulse size={19} />
                <span>85% budget</span>
                <small>engine warns</small>
              </div>
              <ArrowRight size={16} />
              <div>
                <FileIcon />
                <span>Handoff</span>
                <small>agent states what remains</small>
              </div>
              <ArrowRight size={16} />
              <div>
                <GitBranch size={19} />
                <span>Your decision</span>
                <small>revive or escalate</small>
              </div>
            </div>
            <CodeBlock
              code={`// Inside runAgent(task, options):\nrevival: { warnAtPercent: 85 },\nthread: { store: threadStore, id: "task-42" },`}
              filename="revival-options.ts"
            />
            <p>
              <code>request_revival</code> records remaining work and estimates.
              After a budget-limited run, <code>planRevival</code> checks the
              result and <code>ThreadBudget</code>: continue the same task and
              phase, ask a human when thread caps are spent, or do nothing when
              no revival is warranted. Your app queues the next run and persists
              state.
            </p>
            <Callout icon={GitBranch}>
              Git-backed snapshots commit changed work at finish or pause
              boundaries. Optional push carries a checkpoint off-machine. Supply
              a custom <code>SnapshotFn</code> to use another persistence layer.
            </Callout>
          </DocSection>

          <DocSection id="evidence" number="09" title="Test evidence">
            <p>
              <code>AgentResult.ok</code> is a runtime outcome, not permission
              to ship. Tool results live on <code>result.evidence</code>;{" "}
              <code>run_tests</code> records a Git tree hash after the command.
            </p>
            <div className="evidence-receipt">
              <ShieldCheck size={22} />
              <div>
                <strong>Evidence has a workspace-freshness check.</strong>
                <span>
                  <code>latestEvidenceForTree</code> → passed / failed /
                  not_verified
                </span>
              </div>
              <Check size={17} />
            </div>
            <p className="doc-small">
              The helper stages the current tree and checks the latest matching
              evidence. If it can’t inspect the tree, it reports{" "}
              <code>inspected: false</code> — never an invented pass. Your app
              owns the release gate.
            </p>
            <p className="doc-small">A post-command hash is not an immutable
              tested snapshot and does not prove test coverage. For an opt-in
              requirement/evidence gate, see <a href="#verification">Task contracts &amp; the judge</a>.</p>
          </DocSection>

          <DocSection id="traces" number="10" title="Streaming & traces">
            <p>
              Every model call streams. Text, reasoning, tools, compaction,
              checkpoints, and completion arrive as typed events.
            </p>
            <CodeBlock
              code={`// Inside runAgent(task, options):\nonEvent(event) {\n  if (event.type === "llm_text_delta") {\n    process.stdout.write(event.text);\n  }\n},`}
              filename="stream-options.ts"
            />
            <div className="doc-facts">
              <div>
                <strong>One order</strong>
                <p>
                  <code>TraceFanout</code> assigns one sequence across sinks.
                </p>
              </div>
              <div>
                <strong>Record & replay</strong>
                <p>
                  <code>JsonlTrace</code>, a live projector, and conversation
                  replay share the event schema.
                </p>
              </div>
              <div>
                <strong>Redact before writing</strong>
                <p>
                  Known secret patterns are redacted before sinks. Raw{" "}
                  <code>onEvent</code> events are not redacted.
                </p>
              </div>
            </div>
            <p className="doc-small">
              A broken sink doesn’t kill the run. The engine also owns heartbeat
              timers, <code>AbortSignal</code> handling, and cross-process
              cancellation polling. Model-finished events record the model that
              served the call and provider identity when supplied.
            </p>
          </DocSection>

          <DocSection id="providers" number="11" title="Sandbox providers">
            <div className="provider-list">
              {[
                [
                  "heyo",
                  "Firecracker microVMs",
                  "Remote isolation · live conformance path",
                ],
                [
                  "docker",
                  "Containers on your daemon",
                  "CLI-backed · conformance-tested in CI",
                ],
                [
                  "e2b",
                  "E2B cloud sandboxes",
                  "Template-based boot · optional e2b SDK",
                ],
                [
                  "local",
                  "Processes on this host",
                  "No isolation · development / CI only",
                ],
              ].map(([name, title, status]) => (
                <div key={name}>
                  <Terminal size={18} />
                  <div>
                    <strong>{title}</strong>
                    <code>anchor-ai-sdk/sandbox/{name}</code>
                  </div>
                  <span>{status}</span>
                </div>
              ))}
            </div>
            <p className="doc-small">
              E2B is exported since v0.1.6. Daytona remains a stub, not a
              supported backend. Boot settings and isolation guarantees differ.
            </p>
          </DocSection>

          <DocSection id="contract" number="12" title="One machine contract">
            <p>
              <code>SandboxProvider</code> owns create, adopt, release, and
              probe. Every adapter runs self-contained commands with real kill
              deadlines; declared capabilities determine retain, fork, and
              remote-checkpoint support.
            </p>
            <Callout icon={Workflow}>
              Read-only calls from one turn can run concurrently. Mutations stay
              serial. Background detachment via <code>backgroundAfterSecs</code>{" "}
              requires <code>pollJob</code> support (Heyo and Docker). The engine
              polls at turn boundaries and injects/persists finished results.
              Your app still owns sandbox retention and cleanup across runs.
            </Callout>
            <p className="doc-small">
              Credentials enter through environment/adapter secret plumbing, not
              repository files. Keep provider capability checks in your app;
              don’t assume every backend supports every feature.
            </p>
          </DocSection>

          <DocSection id="conformance" number="13" title="Provider conformance">
            <p>
              A provider earns compatibility by passing the executable
              conformance suite: exec fidelity, deadlines, secrets, checkpoints,
              retain/adopt, and declared optional capabilities.
            </p>
            <p>When <code>processStream</code> is declared, scenarios check stdin,
              exit status, kill, deadline, and destroy. Image publishing checks
              declaration/publisher presence; it does not push to a live registry.
              Local runs in CI, Docker needs a daemon, and cloud suites need credentials.</p>
            <CodeBlock
              code={`import { runSandboxConformance } from "anchor-ai-sdk/testing";\n\n// In a Vitest test file, with your provider instance:\nrunSandboxConformance(myProvider);`}
              filename="provider.test.ts"
            />
          </DocSection>

          <DocSection id="tools" number="14" title="Tools & strategies">
            <p>
              <code>chatAgent</code> and <code>codingAgent</code> are bundles,
              not modes. Compose your own strategy, prompts, and tools from the
              same primitives.
            </p>
            <div className="tool-grid">
              {[
                ["bash", "Builds, scripts, installs, shell access"],
                ["read_file", "Line-numbered, paged file reads"],
                ["edit_file", "Unique exact-match edits, byte-verified"],
                ["search", "rg → git grep → grep fallback"],
                ["run_tests", "Structured test results and tree hashes"],
                ["finish", "Declared completion + optional handoff"],
              ].map(([name, description]) => (
                <div key={name}>
                  <code>{name}</code>
                  <span>{description}</span>
                </div>
              ))}
            </div>
            <p className="doc-small">
              <code>defineTool</code> pairs a JSON Schema definition with an
              implementation. Tool <code>content</code> goes to the model;{" "}
              <code>meta</code> stays structured. A consumer-provided{" "}
              <code>handoff.schema</code> shapes <code>finish</code> output —
              the engine carries the object without interpreting its business
              meaning.
            </p>
            <h3>A terminal-native bundle</h3>
            <p><code>terminalAgent</code> uses a terminal-oriented strategy with
              the familiar shell/file/test tools for tasks in an existing
              environment. It is separate from the repository-focused coding prompt.</p>
            <CodeBlock filename="terminal-agent.ts" code={`import { terminalAgent, runAgent } from "anchor-ai-sdk";

// llm is configured and sandbox is already started.
const result = await runAgent(
  { task: "Inspect the environment and repair the failing command" },
  { llm, sandbox, agent: terminalAgent },
);`} />
            <h3>Bound consumer tool output</h3>
            <p>The dispatch boundary caps custom-tool content too. Use
              <code>boundToolResult</code> in your handler for a recoverable
              spill path and a readable preview when scratch storage is available.</p>
            <CodeBlock filename="tool-result.ts" code={`import { boundToolResult } from "anchor-ai-sdk";

// In a custom tool handler:
return {
  ok: true,
  content: await boundToolResult(largeText, {
    sandbox: ctx.sandbox, label: "repository_report",
  }),
};`} />
          </DocSection>

          <DocSection id="testing" number="15" title="Testing">
            <p>
              The SDK includes engine, tool, and trace tests against fakes and
              fixtures, provider conformance suites, and genericity guards.
              Local conformance runs in CI; remote live tests are
              credential-gated.
            </p>
            <a className="doc-inline-link" href={`${repo}/tree/main/tests`}>
              Explore the test suite <ArrowUpRight size={13} />
            </a>
          </DocSection>

          <FeatureDocs Section={DocSection} Callout={Callout} />
          <ConsumerDocs Section={DocSection} Callout={Callout} />

          <DocSection id="status" number="30" title="Status & versioning">
            <p>
              Anchor is 0.x and MIT-licensed. Pin versions, read the source, and
              treat feature availability as version-specific. Agent teams,
              consumer skill bundles, and Daytona are roadmap work. Check the
              tagged source and the <a href="/changelog.html">changelog</a>
              rather than assuming main matches your installed version.
            </p>
            <a
              className="doc-inline-link"
              href={`${repo}/blob/main/DECISIONS.md`}
            >
              Read the engineering decisions <ArrowUpRight size={13} />
            </a>
          </DocSection>
        </div>
      </div>
    </PageShell>
  );
}

function FileIcon() {
  return <BookOpen size={19} />;
}
createRoot(document.getElementById("root")).render(<Docs />);
