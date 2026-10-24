import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import * as Tabs from "@animate-ui/react/primitives/radix-ui/tabs";
import * as Accordion from "@animate-ui/react/primitives/radix-ui/accordion";
import * as Tooltip from "@animate-ui/react/primitives/radix-ui/tooltip";
import { CopyButton, SiteHeader, SiteFooter } from "./ui.jsx";
import { MotionConfig } from "motion/react";
import logo from "../assets/logo.svg";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  Plus,
  RotateCcw,
  Terminal,
  Folder,
  FileText,
  GitBranch,
  ShieldCheck,
  Layers,
  HeartPulse,
  Workflow,
  Command,
  Play,
  Pause,
} from "lucide-react";
import "./styles.css";
import "./typography.css";
import "./theme.css";

const repo = "https://github.com/hrithikkoduri/anchor-ai-sdk";
const capabilities = [
  {
    id: "memory",
    label: "Filesystem memory",
    icon: Folder,
    title: "A context window is not a memory.",
    text: "Notes survive the fold. Oversized output stays on disk. Your agent picks up the thread, not the pieces.",
    tags: ["Durable notes", "Context compaction", "Recoverable spill"],
    file: ".anchor/notes.md",
    rows: [
      ["# Current task", "Fix retry behavior in the HTTP client."],
      ["## What I know", "The timeout resets on every attempt."],
      ["## Next move", "Patch the deadline. Test the slow path."],
    ],
    event: "context compacted → notes preserved",
    metric: "State survives. Context stays small.",
  },
  {
    id: "correction",
    label: "Course correction",
    icon: Workflow,
    title: "Off course is not the end of the run.",
    text: "Catch repetitive calls, empty turns, and runaway prose. Give the agent a clear next move before calling it stalled.",
    tags: ["Loop detection", "Output caps", "One-shot recovery"],
    file: "runtime / guardrails",
    rows: [
      ["01  DETECT", "Repeated identical tool call."],
      ["02  REDIRECT", "Try a different approach or finish."],
      ["03  CONTINUE", "Agent reads the failing test instead."],
    ],
    event: "advisory: repeated_call → next turn",
    metric: "A correction, not another infinite loop.",
  },
  {
    id: "revival",
    label: "Budget revival",
    icon: HeartPulse,
    title: "Out of budget. Not out of context.",
    text: "Before a run runs dry, it can leave a handoff. Your app decides whether to fund the next run — or bring in a human.",
    tags: ["Budget warning", "Agent handoff", "Thread-wide caps"],
    file: "runtime / revival",
    rows: [
      ["01  WARN", "85% of the run budget consumed."],
      ["02  HAND OFF", "“Patch is in. Regression test remains.”"],
      ["03  PLAN", "App checks remaining thread budget."],
    ],
    event: "request_revival → planRevival",
    metric: "The work continues. You hold the purse.",
  },
  {
    id: "evidence",
    label: "Verifiable work",
    icon: ShieldCheck,
    title: "“Done” should come with a receipt.",
    text: "Test commands record outcomes and a post-command tree hash. Check freshness after edits; let your application decide what is enough to ship.",
    tags: ["Structured evidence", "Tree-hash freshness", "Your release policy"],
    file: "runtime / evidence",
    rows: [
      ["run_tests", "✓ 42 passed · 0 failed"],
      ["recorded tree", "a83f2d1 — captured after the command"],
      ["current tree", "a83f2d1 — evidence is fresh"],
    ],
    event: "latestEvidenceForTree → passed",
    metric: "Evidence in the engine. Policy in your app.",
  },
  {
    id: "verification",
    label: "Task contract",
    icon: ShieldCheck,
    title: "Keep the obligations. Check the claims.",
    text: "Opt into a durable requirement ledger and separate verification calls. Track what remains, link tool evidence, and check coverage before claiming done.",
    tags: ["Opt-in verifier", "Append-only ledger", "Thread persistence"],
    file: "runtime / progress ledger",
    rows: [
      ["REQUIREMENT", "Retry deadline holds across attempts."],
      ["EVIDENCE", "Regression command and observed result."],
      ["FINISH CHECK", "Coverage first. Evidence alignment next."],
    ],
    event: "update_ledger → phase / finish verification",
    metric: "A check on completion, not a correctness certificate.",
  },
];

function App() {
  const [playing, setPlaying] = useState(true);
  const [selected, setSelected] = useState("memory");
  return (
    <MotionConfig reducedMotion="user">
      <Tooltip.Provider delayDuration={200}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <SiteHeader page="home" />
        <main id="main">
          <section className="hero container">
            <div className="hero-copy">
              <a className="release" href="/changelog.html#v0.6.0">
                <span className="status-dot" /> v0.6.0 · EARLY ALPHA{" "}
                <ArrowUpRight size={12} />
              </a>
              <h1>
                A loop is easy.
                <br />
                The rest is{" "}
                <span className="anchor-word">
                  Anchor
                  <svg viewBox="0 0 300 16" aria-hidden="true">
                    <path d="M2 10 Q140 0 297 8 M30 15 Q165 8 278 12" />
                  </svg>
                </span>
                .
              </h1>
              <p>
                The infrastructure between <span>“do this”</span> and{" "}
                <span>actually done.</span> Evidence, recovery, and sandboxed
                tools — in one agent harness SDK.
              </p>
              <div className="hero-actions">
                <a className="button primary" href="/docs.html#quickstart">
                  Build your agent <ArrowUpRight size={17} />
                </a>
                <a className="text-link" href="#harness">
                  Explore the harness <ArrowRight size={15} />
                </a>
              </div>
              <div className="install">
                <span className="prompt">$</span>
                <code>npm install anchor-ai-sdk</code>
                <CopyButton text="npm install anchor-ai-sdk" />
              </div>
              <div className="hero-meta">
                <span>TypeScript-native</span>
                <i /> MIT licensed
                <i /> Your model. Your machine.
              </div>
            </div>
            <div className={`runtime ${playing ? "is-playing" : ""}`}>
              <div className="runtime-top">
                <span>
                  <span className="status-dot" /> ANCHOR RUNTIME
                </span>
                <span className="runtime-id">run_08f2</span>
              </div>
              <div className="runtime-task">
                <span className="tiny-label">TASK IN</span>
                <p>Fix the retry logic. Prove it works.</p>
                <span className="task-tag">
                  <GitBranch size={11} /> workspace / main
                </span>
              </div>
              <div className="loop-area">
                <div className="loop-label">
                  <span>THE AGENT LOOP</span>
                  <button
                    type="button"
                    onClick={() => setPlaying(!playing)}
                    aria-label={
                      playing
                        ? "Pause runtime animation"
                        : "Play runtime animation"
                    }
                  >
                    {playing ? <Pause size={12} /> : <Play size={12} />}
                  </button>
                </div>
                <div className="loop-track">
                  <div className="loop-node">
                    <Command size={19} />
                    <span>Reason</span>
                  </div>
                  <span className="loop-connector">
                    <i />
                  </span>
                  <div className="loop-node active">
                    <Terminal size={19} />
                    <span>Act</span>
                  </div>
                  <span className="loop-connector">
                    <i />
                  </span>
                  <div className="loop-node">
                    <Layers size={19} />
                    <span>Observe</span>
                  </div>
                </div>
                <div className="return-path">
                  <span>↳</span>
                  <div />
                  <span>repeat, with context</span>
                  <RotateCcw size={11} />
                </div>
              </div>
              <div className="runtime-foundations">
                <span>
                  <Folder size={13} /> Memory
                </span>
                <span>
                  <Workflow size={13} /> Guardrails
                </span>
                <span>
                  <HeartPulse size={13} /> Revival
                </span>
              </div>
              <div className="trace">
                <div className="trace-label">
                  <span>EVENT STREAM</span>
                  <span>ILLUSTRATIVE RUN</span>
                </div>
                <div>
                  <span className="trace-time">00:01</span>
                  <span className="trace-key">read_file</span>
                  <span>src/client.ts</span>
                  <Check size={12} />
                </div>
                <div>
                  <span className="trace-time">00:03</span>
                  <span className="trace-key">edit_file</span>
                  <span>deadline fixed</span>
                  <Check size={12} />
                </div>
                <div className="trace-last">
                  <span className="trace-time">00:05</span>
                  <span className="trace-key">run_tests</span>
                  <span>42 passed</span>
                  <span className="trace-receipt">tree a83f2d1</span>
                </div>
              </div>
              <div className="runtime-bottom">
                <ShieldCheck size={13} />
                <span>Not just an answer. An evidence trail.</span>
                <span className="status-dot" />
              </div>
              <div className="runtime-caption">
                <span className="caption-line" /> THE MODEL THINKS. THE HARNESS
                HOLDS.
              </div>
            </div>
          </section>
          <div className="compatibility container">
            <span>
              ONE CONTRACT.
              <br />
              <strong>YOUR STACK.</strong>
            </span>
            <div>OpenAI-compatible models</div>
            <span className="compat-plus">+</span>
            <div>Heyo microVMs</div>
            <div>E2B</div>
            <div>Docker</div>
            <div>Local</div>
            <a href="/docs.html#contract">
              Bring your own <ArrowUpRight size={13} />
            </a>
          </div>

          <section className="harness-section" id="harness">
            <div className="container">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">
                    <span className="cross">+</span> 01 / THE HARNESS
                  </span>
                  <h2>
                    Built for the turns
                    <br />
                    that don’t go to plan.
                  </h2>
                </div>
                <p>
                  Models can reason.
                  <br />
                  Give yours the system to keep going.
                </p>
              </div>
              <Tabs.Root
                value={selected}
                onValueChange={setSelected}
                className="capabilities"
              >
                <Tabs.List
                  className="capability-tabs"
                  aria-label="Harness capabilities"
                >
                  {capabilities.map((c) => (
                    <Tabs.Trigger value={c.id} key={c.id}>
                      <c.icon size={16} />
                      {c.label}
                      <ArrowUpRight size={13} className="tab-arrow" />
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
                {capabilities.map((c) => (
                  <Tabs.Content
                    key={c.id}
                    value={c.id}
                    className="capability-panel"
                  >
                    <div className="capability-description">
                      <div className="feature-symbol">
                        <c.icon size={26} strokeWidth={1.5} />
                      </div>
                      <h3>{c.title}</h3>
                      <p>{c.text}</p>
                      <div className="feature-tags">
                        {c.tags.map((tag) => (
                          <span key={tag}>
                            <Check size={12} />
                            {tag}
                          </span>
                        ))}
                      </div>
                      <a
                        className="text-link"
                        href={`/docs.html#${c.id}`}
                      >
                        Under the hood <ArrowUpRight size={14} />
                      </a>
                    </div>
                    <div className="feature-demo">
                      <div className="demo-file">
                        <FileText size={14} />
                        <span>{c.file}</span>
                        <span className="demo-flag">ILLUSTRATION</span>
                      </div>
                      <div className="demo-rows">
                        {c.rows.map(([key, val], i) => (
                          <div key={key}>
                            <span className="line-number">0{i + 1}</span>
                            <div>
                              <span className="demo-key">{key}</span>
                              <p>{val}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="demo-event">
                        <span className="status-dot" />
                        {c.event}
                      </div>
                      <div className="demo-caption">
                        <span>↳</span>
                        {c.metric}
                      </div>
                    </div>
                  </Tabs.Content>
                ))}
              </Tabs.Root>
              <div className="secondary-features">
                <div>
                  <Terminal size={17} />
                  <span>
                    Sandbox-first execution
                    <small>Images, process streams, optional LSP.</small>
                  </span>
                </div>
                <div>
                  <GitBranch size={17} />
                  <span>
                    Checkpoints & resume
                    <small>Save the workspace, not just the chat.</small>
                  </span>
                </div>
                <div>
                  <Workflow size={17} />
                  <span>
                    One replayable trace
                    <small>Stream it live. Inspect it later.</small>
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section className="proof-section container" id="proof">
            <div className="proof-intro">
              <span className="eyebrow">
                <span className="cross">+</span> 02 / EVIDENCE, NOT A SLOGAN.
              </span>
              <h2>
                Inspect the run.
                <br />
                Keep the limits visible.
              </h2>
              <p>
                Anchor vs. mini-swe-agent.
                <br />
                10 SWE-bench Lite tasks. Same model.
                <br />
                Selected sample. Official grader.
              </p>
              <a className="text-link" href="/benchmarks.html">
                Historical baseline <ArrowUpRight size={15} />
              </a>
              <p><a className="text-link" href={`${repo}/tree/main/evals/benchmarks/swe-bench/results/glm53-parasail`}>Parasail artifacts <ArrowUpRight size={15} /></a></p>
            </div>
            <div className="proof-numbers">
              <div className="resolution">
                <span>RESOLVED</span>
                <strong>
                  9<span>/10</span>
                </strong>
                <span>both harnesses</span>
              </div>
              <div className="cost-comparison">
                <div className="cost-label">
                  <span>REPORTED RUN COST</span>
                  <span>GLM 5.3 · PARASAIL</span>
                </div>
                <div className="cost-row">
                  <span>
                    <img src={logo} alt="" />
                    Anchor
                  </span>
                  <strong>$4.32</strong>
                </div>
                <div className="cost-row mini">
                  <span>mini-swe-agent</span>
                  <strong>Not reported</strong>
                </div>
                <p className="benchmark-note">
                  Small-sample baseline, not a general performance claim.
                  <br />
                  Different budgets and an extraction failure; no cost-ratio
                  or v0.1.8 improvement claim.
                </p>
              </div>
            </div>
          </section>

          <section className="build-section" id="build">
            <div className="container build-grid">
              <div>
                <span className="eyebrow">
                  <span className="cross">+</span> 03 / YOUR AGENT. NOT OUR
                  OPINIONS.
                </span>
                <h2>
                  Bring the ambition.
                  <br />
                  We brought the plumbing.
                </h2>
                <p>
                  A model, a machine, and a task.
                  <br />
                  The rest is already wired.
                </p>
                <a className="button primary" href="/docs.html#quickstart">
                  Start building <ArrowUpRight size={17} />
                </a>
                <div className="build-footnote">
                  NO PLATFORM LOCK-IN. NO HIDDEN ORCHESTRATOR.
                </div>
              </div>
              <div className="code-window">
                <div className="code-header">
                  <span>
                    <span className="status-dot" /> agent.ts
                  </span>
                  <CopyButton text={code} label="Copy code example" />
                </div>
                <pre>
                  <code>
                    <span className="syntax-muted">
                      // Your model. Your sandbox. One run.
                    </span>
                    {"\n"}
                    <span className="syntax-orange">import</span>
                    {" { codingAgent, runAgent }\n  "}
                    <span className="syntax-orange">from</span>{" "}
                    <span className="syntax-green">"anchor-ai-sdk"</span>
                    {";\n\n"}
                    <span className="syntax-muted">
                      // llm and sandbox configured by your app
                    </span>
                    {"\n"}
                    <span className="syntax-orange">const</span>
                    {" result = "}
                    <span className="syntax-orange">await</span>
                    {" runAgent(\n  { task: "}
                    <span className="syntax-green">"Fix the failing test"</span>
                    {" },\n  { llm, sandbox, agent: codingAgent },\n);\n\n"}
                    <span className="syntax-muted">
                      // The answer, and the receipts.
                    </span>
                    {"\nconsole.log(result.summary, result.evidence);"}
                  </code>
                </pre>
                <a href="/docs.html#machine" className="code-footer">
                  See the complete setup <ArrowRight size={14} />
                </a>
              </div>
            </div>
          </section>

          <section className="questions container">
            <div>
              <span className="eyebrow">
                <span className="cross">+</span> A FEW GOOD QUESTIONS
              </span>
              <h2>
                Small surface.
                <br /> Strong foundations.
              </h2>
            </div>
            <Accordion.Root type="single" collapsible className="faq">
              {[
                [
                  "Is this only for coding agents?",
                  "No. The engine is strategy-agnostic. Use the chat bundle, the coding bundle, or compose your own prompts and tools. A sandbox is optional for agents that don’t need a machine.",
                ],
                [
                  "What do I still control?",
                  "Your model, prompts, tools, storage, sandbox provider, budgets, and release policy. The SDK supplies mechanics — it doesn’t decide what your product should allow or publish.",
                ],
                [
                  "Does revival happen automatically?",
                  "No. Opt in to budget warnings and handoff requests. Your app uses planRevival and a thread-wide budget to decide whether to fund another run or escalate to a human.",
                ],
                [
                  "What is the design philosophy?",
                  "Mechanics in the SDK, policy in your app. Keep requirements durable, ground completion in evidence, and never replay an uncertain external write blindly. Verification is optional; capabilities and their limits should be explicit.",
                ],
                [
                  "Can I ship with it today?",
                  "Anchor is early alpha. Pin exact versions and test your integration. E2B and progressive skills are shipped, and agent teams are available as one-level crews with worker memory and parallel delegation. Daytona, MCP, and recursive teams remain roadmap work. Process streams, image publishing, and LSP have provider-specific limits documented in the v0.6.0 changelog.",
                ],
              ].map(([q, a], i) => (
                <Accordion.Item value={`faq-${i}`} key={q}>
                  <Accordion.Header>
                    <Accordion.Trigger>
                      {q}
                      <Plus size={17} />
                    </Accordion.Trigger>
                  </Accordion.Header>
                  <Accordion.Content>
                    <p>{a}</p>
                  </Accordion.Content>
                </Accordion.Item>
              ))}
            </Accordion.Root>
          </section>
        </main>
        <SiteFooter />
      </Tooltip.Provider>
    </MotionConfig>
  );
}

const code = `import { codingAgent, runAgent } from "anchor-ai-sdk";

// llm and sandbox configured by your app.
// Complete setup: /docs.html#machine
const result = await runAgent(
  { task: "Fix the failing test" },
  { llm, sandbox, agent: codingAgent },
);

console.log(result.summary, result.evidence);`;

createRoot(document.getElementById("root")).render(<App />);
