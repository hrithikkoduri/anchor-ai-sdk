import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Collapsible from "@animate-ui/react/primitives/radix-ui/collapsible";
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
  ShieldCheck,
  Terminal,
  Workflow,
} from "lucide-react";
import { CodeBlock, CopyButton, PageShell, repo } from "./ui.jsx";
import { CustomAgentExample } from "./agent-example.jsx";
import { SandboxSetup } from "./sandbox-setup.jsx";
import {
  CompactionGuide,
  CourseCorrectionGuide,
  RevivalGuide,
} from "./runtime-configuration.jsx";
import { StreamingGuide, ToolsGuide } from "./integration-guides.jsx";
import { ProviderBrand } from "./provider-brand.jsx";
import { MessageDeliveryGuide } from "./message-delivery.jsx";
import { BackgroundGuide } from "./background-guide.jsx";
import "./styles.css";
import "./pages.css";
import "./typography.css";
import "./sandbox.css";
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
      ["messages", "Messages & inbox"],
      ["correction", "Course correction"],
      ["memory", "Filesystem memory"],
      ["compaction", "Context compaction"],
      ["revival", "Revival & resume"],
      ["evidence", "Evidence"],
      ["traces", "Streaming & traces"],
      ["background", "Background tools"],
    ],
  ],
  [
    "BUILD ON IT",
    [
      ["providers", "Sandbox providers"],
      ["contract", "The contract"],
      ["conformance", "Conformance"],
      ["tools", "Tools & strategies"],
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
              <span>SDK 0.1.7</span>
              <span>Provider API key required</span>
            </div>
          </header>

          <DocSection id="install" number="01" title="Install">
            <div className="doc-install">
              <Terminal size={16} />
              <code>npm install anchor-ai-sdk@0.1.7</code>
              <CopyButton
                text="npm install anchor-ai-sdk@0.1.7"
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
              and run it. <code>.mjs</code> tells Node to use JavaScript ES
              modules; <code>.js</code> also works in a project with
              <code>"type": "module"</code>. Model calls may incur cost.
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
                <span>Tool name, status, and metadata</span>
                <code>usage</code>
                <span>Tokens and known cost</span>
                <code>reason</code>
                <span>Why the run ended</span>
              </div>
            </div>
            <p className="doc-small">
              <code>llmFromCatalog</code> uses the provider catalog’s pricing
              and context-window metadata when available. Pass its{" "}
              <code>compaction</code> configuration into the engine, as above.
              Metadata failures fall back rather than breaking the run.
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
            <SandboxSetup />
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
              pricing; step and token limits still apply without it. Usage is
              checked between model turns, so a call can overshoot a run budget.
              The output cap is a separate per-call request limit.
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
          </DocSection>

          <DocSection id="messages" number="06" title="Messages, context & inbox">
            <MessageDeliveryGuide />
          </DocSection>

          <DocSection id="correction" number="07" title="Course correction">
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
            <CourseCorrectionGuide />
          </DocSection>

          <DocSection id="memory" number="08" title="Filesystem memory">
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
                    Agents can keep notes at <code>.anchor/notes.md</code>. The
                    adapters initially exclude the reserved directory and
                    force-add the notes file to Git checkpoints. Compaction
                    doesn’t rewrite this file; it is not automatically
                    populated.
                  </p>
                </div>
              </div>
              <div>
                <Command size={18} />
                <div>
                  <h3>Conversation across runs</h3>
                  <p>
                    <code>ThreadStore</code> carries the summary, recent
                    messages, and phase when a store is supplied.{" "}
                    <code>MemoryThreadStore</code> ships for single-process
                    development; durable storage is yours to provide.
                  </p>
                </div>
              </div>
              <div>
                <Terminal size={18} />
                <div>
                  <h3>Spill, don’t discard</h3>
                  <p>
                    Oversized tool output is clipped (300 lines / 20k characters
                    by default). The built-in tools attempt a full-output spill
                    to sandbox scratch storage, with a pointer for later reads.
                    Spills are best-effort and limited to 4M characters.
                  </p>
                </div>
              </div>
            </div>
            <Callout>
              Assistant-text elision bounds the model’s replay,{" "}
              <strong>not the stored transcript</strong>: 20k characters per
              reply by default, or 12k head-only for a capped reply. Compaction
              separately summarizes older messages. Full-text spills require
              sandbox scratch storage and can fail. Durable notes and stores are
              useful persistence primitives, not a guarantee against data loss.
            </Callout>
          </DocSection>

          <DocSection id="compaction" number="09" title="Context compaction">
            <CompactionGuide />
          </DocSection>

          <DocSection id="revival" number="10" title="Revival & resume">
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
            <RevivalGuide />
            <Callout icon={GitBranch}>
              Git-backed snapshots commit changed work at finish or pause
              boundaries. Optional push carries a checkpoint off-machine. Supply
              a custom <code>SnapshotFn</code> to use another persistence layer.
            </Callout>
          </DocSection>

          <DocSection id="evidence" number="11" title="Test evidence">
            <p>
              <code>AgentResult.ok</code> is a runtime outcome, not permission
              to ship. <code>result.evidence</code> records tool names, status,
              and metadata. <code>run_tests</code> records its command, exit
              code, timeout, duration, and a <strong>post-run</strong> Git tree
              hash when available.
            </p>
            <div className="evidence-receipt">
              <ShieldCheck size={22} />
              <div>
                <strong>
                  Recorded command outcome. Optional freshness check.
                </strong>
                <span>
                  <code>latestEvidenceForTree</code> → passed / failed /
                  not_verified
                </span>
              </div>
              <Check size={17} />
            </div>
            <p className="doc-small">
              The helper stages the current tree and compares its hash with the
              latest <code>run_tests</code> event marked as executed. An
              inspectable matching hash and successful tool status produce
              <code>passed</code>. If it can’t inspect the tree, it reports
              <code>inspected: false</code>.
            </p>
            <Callout icon={ShieldCheck}>
              This is not proof of correctness or of an immutable tested
              snapshot. The hash is captured after the command; ignored files
              and the wider environment are outside it. The helper does not
              require a full-suite command or inspect test assertions. Your app
              must decide which commands and evidence it trusts, and whether
              anything may be published.
            </Callout>
          </DocSection>

          <DocSection id="traces" number="12" title="Streaming & traces">
            <StreamingGuide />
          </DocSection>

          <DocSection id="background" number="13" title="Background tools & results">
            <BackgroundGuide />
          </DocSection>

          <DocSection id="providers" number="14" title="Sandbox providers">
            <p>
              The sandbox layer can be used with agents or directly through{" "}
              <code>SandboxProvider</code> and <code>Sandbox</code>. Provider
              factories live on subpaths; the engine and built-in machine tools
              share the same interface. Configure the backend once rather than
              giving every tool its own vendor integration.
            </p>
            <div className="provider-list">
              {[
                [
                  "heyo",
                  "Firecracker microVMs",
                  "Image-based · opt-in live conformance suite",
                ],
                [
                  "e2b",
                  "E2B cloud sandboxes",
                  "Template-based · offline lifecycle tests + opt-in live suite",
                ],
                [
                  "docker",
                  "Containers on your daemon",
                  "Image-based · conformance job configured in CI",
                ],
                [
                  "local",
                  "Processes on this host",
                  "No isolation · development / CI only",
                ],
              ].map(([name, title, status]) => (
                <div key={name}>
                  <div>
                    <strong>
                      <ProviderBrand id={name} />
                    </strong>
                    <span className="provider-description">{title}</span>
                    <code>anchor-ai-sdk/sandbox/{name}</code>
                  </div>
                  <span>{status}</span>
                </div>
              ))}
            </div>
            <p className="doc-small">
              E2B, Heyo, Docker, and local are implemented adapters. Daytona
              remains planned and is not an exported package subpath. Optional
              capabilities differ: E2B and local declare fork support; Heyo and
              Docker do not. The latest Docker source declares egress control:
              <code>spec.egress: "none"</code> disconnects networks after startup.
              The other adapters reject that setting rather than silently
              running with network access.
            </p>
          </DocSection>

          <DocSection id="contract" number="15" title="One machine contract">
            <p>
              <code>SandboxProvider</code> owns create, adopt, release, and
              probe. <code>create</code> constructs a sandbox;{" "}
              <code>start</code>
              boots it and prepares the workspace. The common interface covers
              exec, Git checkpoints, tree comparison, and teardown. Adapters
              implement command deadlines; declared capabilities and provider
              behavior determine retention, fork, and remote-checkpoint support.
            </p>
            <CodeBlock
              code={`import { openSandbox } from "anchor-ai-sdk";\n\n// provider is any configured SandboxProvider, from the examples above.\nconst sandbox = await openSandbox({\n  provider,\n  spec: { repoUrl, ref: "main" },\n});\ntry {\n  const result = await sandbox.exec("git status --short", { timeoutSecs: 30 });\n  console.log(result.exitCode, result.stdout, result.stderr);\n} finally {\n  await sandbox.destroy();\n}`}
              filename="machine-without-agent.mjs"
              language="JAVASCRIPT"
            />
            <p className="doc-small">
              <code>retain: true</code> changes teardown into provider-specific
              retention (for example, E2B pause or Docker stop). Store the
              handle for a later <code>adopt</code>; your app must set a cleanup
              policy and eventually call <code>provider.release</code>.
              Retention and cleanup are not free or automatic across runs. Use{" "}
              <code>openSandboxSession</code> with a store for adoption/fallback
              bookkeeping.
            </p>
            <Callout icon={Workflow}>
              Calls marked read-only from one turn can run concurrently. The
              engine dispatches other tool calls serially; this is not a ban on
              external or detached processes changing the workspace. Background
              detachment requires a participating tool, a consumer threshold,
              and <code>pollJob</code> support (currently Heyo). In 0.1.7 the
              engine polls and delivers results during the call and carries
              outstanding jobs through an inbox chain. After the call returns,
              your host owns saving <code>pendingJobs</code>, waking another
              run with <code>resumeJobs</code>, and cleanup.
            </Callout>
            <p className="doc-small">
              Credentials enter through environment/adapter secret plumbing, not
              repository files. Keep provider capability checks in your app;
              don’t assume every backend supports every feature.
            </p>
          </DocSection>

          <DocSection id="conformance" number="16" title="Provider conformance">
            <p>
              The SDK includes one executable conformance suite for the shared
              contract: exec results, command deadlines, env/cwd handling, Git
              checkpoints, retain/adopt, and declared optional capabilities.
              Scenarios run through the public interface rather than vendor
              internals.
            </p>
            <p className="doc-small">
              For another backend, implement <code>SandboxProvider</code> and{" "}
              <code>Sandbox</code>, declare only the capabilities it supports,
              and run this suite against it. Agent code can keep using the
              common interface; provider-specific boot and lifecycle behavior
              stays in the adapter.
            </p>
            <CodeBlock
              code={`import { e2b } from "anchor-ai-sdk/sandbox/e2b";\nimport { runSandboxConformance } from "anchor-ai-sdk/testing";\n\n// In a Vitest test file. This starts real cloud sandboxes and may incur cost.\nrunSandboxConformance(\n  e2b({ apiKey: process.env.E2B_API_KEY, template: process.env.E2B_TEMPLATE }),\n  {\n    timeoutMs: 240_000,\n    repo: { repoUrl: "https://github.com/octocat/Hello-World.git" },\n  },\n);`}
              filename="provider.test.ts"
            />
            <p className="doc-small">
              The repository configures local and Docker conformance in CI. Heyo
              and E2B live suites are credential-gated; the presence of a suite
              does not mean a given account, image, template, or provider
              version has passed it. Capability flags and optional repository
              fixtures affect which scenarios run. Conformance checks the public
              behavior contract, not security isolation or performance.
            </p>
          </DocSection>

          <DocSection id="tools" number="17" title="Tools & strategies">
            <ToolsGuide />
            <p>
              <code>chatAgent</code> and <code>codingAgent</code> are bundles,
              not modes. Compose your own strategy, prompts, and tools from the
              same primitives.
            </p>
            <div className="tool-grid">
              {[
                ["bash", "Builds, scripts, installs, shell access"],
                ["read_file", "Line-numbered, paged file reads"],
                ["edit_file", "Unique exact-match edits, write-size checked"],
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
              meaning. The schema is declared to the model; validate the object
              against your own schema and business rules in the consuming app.
            </p>
          </DocSection>

          <DocSection id="testing" number="18" title="Testing">
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

          <DocSection id="status" number="19" title="Status & versioning">
            <p>
              Anchor is 0.x and MIT-licensed. Pin versions, read the source, and
              treat feature availability as version-specific. Agent teams,
              consumer skill bundles, and Daytona are roadmap work. These
              examples target the published <code>0.1.7</code> package and source
              <code>193963a</code>. Native inbox and background examples are
              checked against that installed package, not just an export map. Source inspection
              and offline tests are not a claim that every provider deployment
              has been certified or that all integrations will work unchanged.
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
