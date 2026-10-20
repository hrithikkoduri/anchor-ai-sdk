import React from "react";
import * as Accordion from "@animate-ui/react/primitives/radix-ui/accordion";
import { ArrowRight, ArrowUpRight, BookOpen, Plus } from "lucide-react";
import { mountPage } from "./client.jsx";
import { PageShell, repo } from "./ui.jsx";
import { PhilosophyCover, CompositionDiagram, PhaseDiagram, SandboxDiagram, MemoryDiagram, ContinuityDiagram, EvidenceDiagram, BudgetDiagram } from "./philosophy-diagrams.jsx";
import "./styles.css";
import "./pages.css";
import "./typography.css";
import "./theme.css";
import "./philosophy.css";

const chapters = [
  ["composition", "Compose, don't fork the runtime"],
  ["agency", "A compass, not a conveyor belt"],
  ["environment", "Give actions a shared place"],
  ["memory", "Retain more. Replay less."],
  ["continuity", "Continue at honest boundaries"],
  ["evidence", "Separate completion from trust"],
  ["bounds", "Bound the work, preserve the handoff"],
  ["ownership", "Keep the seam visible"],
];

function Principle({ id, number, title, lead, children }) {
  return <section className="ph-principle" id={id} aria-labelledby={`${id}-title`}><div className="ph-principle-heading"><span>{number}</span><h2 id={`${id}-title`}>{title}</h2></div><p className="ph-principle-lead">{lead}</p>{children}</section>;
}

function SourceNote({ value, title, children, links }) {
  return <Accordion.Root type="single" collapsible className="ph-source"><Accordion.Item value={value}><Accordion.Header><Accordion.Trigger><span>From principle to contract: {title}</span><Plus size={17} /></Accordion.Trigger></Accordion.Header><Accordion.Content><p>{children}</p><div>{links.map(([label, path]) => <a href={path.startsWith("/") ? path : `${repo}/blob/main/${path}`} key={path}>{label}<ArrowUpRight size={13} /></a>)}</div></Accordion.Content></Accordion.Item></Accordion.Root>;
}

export default function Philosophy() {
  return <PageShell page="philosophy"><article className="ph-page container">
    <header className="ph-hero"><div><span className="eyebrow"><span className="cross">+</span> THE THINKING BEHIND THE HARNESS</span><h1>Let the model reason.<br /><span>Make the work real.</span></h1><p>An agent is more than a prompt and a loop. It needs a place to act, a way to carry what it learns, and boundaries that mean something when the work gets complicated.</p><p className="ph-hero-secondary">This is the philosophy behind Anchor: reusable execution mechanics, without quietly taking ownership of your application's judgment.</p><div className="ph-hero-meta"><span><BookOpen size={14} /> A visual reading guide</span><span>Reviewed for SDK 0.1.7</span></div></div><PhilosophyCover /></header>

    <nav className="ph-contents" aria-label="Philosophy chapters"><span>THE READING PATH</span><div>{chapters.map(([id, title], index) => <a href={`#${id}`} key={id}><span>{String(index + 1).padStart(2, "0")}</span>{title}<ArrowRight size={13} /></a>)}</div></nav>

    <div className="ph-origin"><span className="ph-margin-label">THE PREMISE</span><div><h2>Build the behavior once.<br />Stop rebuilding the machinery.</h2><p>Anchor grew out of building Sailor, an issue-to-PR agent. The same concerns kept turning up around the interesting part of the work: assembling context, executing tools, observing results, keeping a workspace, recording a journal, and deciding how another turn could continue.</p><p>Those mechanics should not have to be rebuilt for every new agent. But extracting them should not turn a coding application's assumptions into rules for every consumer. A chat assistant, a research thread, and a repository agent can share an engine without sharing a personality, a database, or a publication policy.</p><p>That tension is the starting point: <strong>make the runtime more capable without making the application less explicit.</strong></p></div></div>

    <div className="ph-reading-body">
      <Principle id="composition" number="01" title="Compose the agent. Don't fork the runtime." lead="Behavior and capabilities should be data the engine can execute—not a new class hierarchy or a second loop.">
        <p>A strategy describes instructions, meaningful phases, and startup requirements. Tools pair a model-visible schema with a handler. An agent bundles the two. The host supplies the live model client and the resources needed for this execution.</p>
        <CompositionDiagram />
        <p>This is why the built-in agents are bundles, not modes. Swapping a prompt or curating a tool set should not require copying the engine. A sandbox-free assistant can use the same loop as a machine-backed coding agent; their capabilities differ, not the fundamental execution model.</p>
        <p className="ph-consequence"><strong>The practical consequence:</strong> put reusable behavior in the agent and environment-specific choices in the run. Keep credentials, storage, and application services explicit.</p>
        <SourceNote value="composition-source" title="Agent, AgentStrategy, Tool" links={[["Agent bundle", "src/agents/types.ts"], ["Strategy contract", "src/engine/strategy.ts"], ["Build from primitives", "/docs.html#primitives"]]}>An agent or strategy and an LLM client are required. Explicit engine strategy/tools options override the bundle per field; an explicit tools array replaces its list. No implicit chat agent or opaque external agent.run() loop is adopted for you.</SourceNote>
      </Principle>

      <Principle id="agency" number="02" title="Phases are a compass, not a conveyor belt." lead="A useful approach is not the same thing as a mandatory itinerary.">
        <p>Investigating a bug, explaining a file, and reviewing a proposed change need different paths. Forcing all of them through reproduce → edit → verify can turn a reasonable answer into an artificial retry loop. Anchor lets the agent choose its next action from the observations it actually has.</p>
        <PhaseDiagram />
        <p>Phases make the work legible. They give the prompt a vocabulary and the application a progress signal. They can be skipped or revisited, and finishing does not require reaching a final phase. That flexibility does not remove real boundaries: the host still chooses tools, budgets, cancellation, and publication policy.</p>
        <p className="ph-consequence"><strong>The practical consequence:</strong> use phase goals to guide reasoning. Use application code—not a phase label—to enforce an approval, permission, or release gate.</p>
        <SourceNote value="agency-source" title="set_phase changes a label" links={[["Decision log · #51 and #74", "DECISIONS.md"], ["Engine strategy", "src/engine/strategy.ts"], ["Phases in code", "/docs.html#phases"]]}>For a multi-phase strategy, the engine normally adds set_phase. It updates the current phase and emits an event; it does not call a phase handler or restrict tools to that phase. startPhase and pauseAfterPhase are caller controls, not a fixed workflow graph.</SourceNote>
      </Principle>

      <Principle id="environment" number="03" title="Give actions a shared place to happen." lead="A coherent execution environment is more useful than a collection of unrelated command wrappers.">
        <p>When a tool reads a file, runs a command, or records a check, its result should describe the environment the next tool will work in. The sandbox contract gives machine-backed tools that shared place: a workspace, scratch storage, command execution, and supported lifecycle operations.</p>
        <SandboxDiagram />
        <p>The provider seam keeps machine choice out of agent behavior. It does not pretend a local process, a container, and a remote microVM have identical guarantees. Capabilities such as retention, fork, and egress control must be declared and tested, not inferred from an adapter's name.</p>
        <p className="ph-consequence"><strong>The practical consequence:</strong> choose the toolchain, backend, permissions, and cleanup policy deliberately. “Sandbox-first” is an execution model, not a claim that every backend is a security boundary.</p>
        <SourceNote value="environment-source" title="capabilities are promises" links={[["Provider contract", "src/sandbox/provider.ts"], ["Conformance suite", "src/testing.ts"], ["Configure a machine", "/docs.html#machine"]]}>Provider factories construct; start boots and prepares the workspace. Optional capabilities differ. Local execution runs with host permissions. A conformance suite checks declared behavior under its configured scenarios; it is not a security certification or proof that every cloud setup has been exercised.</SourceNote>
      </Principle>

      <Principle id="memory" number="04" title="Retain more. Replay less." lead="What the system keeps and what the model sees now are different questions.">
        <p>A context window is a working surface, not a universal archive. Replaying every old response and every oversized tool result makes that surface harder to use. Anchor separates bounded model context, persisted conversation, and workspace artifacts so each can do its own job.</p>
        <MemoryDiagram />
        <p>Compaction summarizes older conversation; it does not rewrite the agent's notes. A tool can leave a short observation and a pointer to a larger output artifact. A supplied thread store carries conversation into a later run. These mechanisms complement one another, but none makes the others unnecessary.</p>
        <p className="ph-consequence"><strong>The practical consequence:</strong> design for retrieval and re-entry, not just a larger prompt. Decide what must survive, where it lives, and how a resumed agent can find it.</p>
        <div className="ph-limit"><strong>The limits are part of the design.</strong><p>Summaries are lossy. Notes must be written by the agent. Output spill is bounded and best-effort. In-memory stores are not crash-durable, and a failed checkpoint is not a backup. Choose and observe the persistence path your application actually needs.</p></div>
        <SourceNote value="memory-source" title="separate replay from retention" links={[["ThreadStore", "src/engine/thread.ts"], ["Compaction", "src/engine/compaction.ts"], ["Memory guide", "/docs.html#memory"]]}>Assistant-text elision bounds replay rather than rewriting the stored transcript. Runtime background facts survive normal thread-history filtering; transient engine advisories do not. Provenance is not secrecy: the model can repeat model-visible information, and the host owns display, redaction, and retention.</SourceNote>
      </Principle>

      <Principle id="continuity" number="05" title="Continue at honest boundaries." lead="A task can outlive a turn, a command, or a worker. The system must be clear about which boundary it is crossing.">
        <p>New information should not corrupt an in-flight assistant/tool exchange. A queued message leaves the active run untouched. An interjection requests a switch at a safe boundary. Once an inbox store exposes the pending work, the engine can own chaining instead of making every application write its own abort-and-restart wrapper.</p>
        <ContinuityDiagram />
        <p>The same separation applies to background commands. A participating tool and polling-capable provider can detach work; Anchor polls and delivers the result during the call and carries pending jobs through an inbox chain. Interjecting is not the same as killing that command or undoing its writes.</p>
        <p>After the call returns, the clock belongs to the host again. A worker has to be woken, persisted state restored, the appropriate machine adopted, and remaining job handles handed back. An interface enables that continuity; it does not create a durable scheduler or exactly-once delivery by itself.</p>
        <p className="ph-consequence"><strong>The practical consequence:</strong> let the engine own deterministic timing within its call. Give your application explicit responsibility for storage, leases, idempotency, wake-up, and cleanup outside it.</p>
        <SourceNote value="continuity-source" title="the store is yours; the chain is the engine's" links={[["Decision log · #81 and #82", "DECISIONS.md"], ["Inbox contract", "src/engine/inbox.ts"], ["Background delivery", "/docs.html#background"]]}>Inbox runs share an allowance rather than refilling it. Optional hasPending lets a normal finish avoid waiting for background jobs when inbox work is pending. The call can still stop with pendingJobs. Cross-call resume uses resumeJobs on the appropriate retained machine; store failures and settlement do not guarantee exactly-once processing.</SourceNote>
      </Principle>

      <Principle id="evidence" number="06" title="Completion is an outcome. Trust is a decision." lead="Record what happened without pretending it proves more than it does.">
        <p>A final answer can be valid without a test run: sometimes the task was to explain something. A successful runtime outcome should not secretly mean “verified” or “publish this.” Anchor records tool evidence independently, allowing an application to make a separate decision at a consequential boundary.</p>
        <EvidenceDiagram />
        <p>For a coding application, that decision might consider a trusted test command, its exit status, the current tree, permissions, and checks outside the agent. A post-run tree hash can help detect a later change. It is not an immutable snapshot of the bytes executed, and it does not cover ignored files, external inputs, or the meaning of the assertions.</p>
        <p>Observability follows the same philosophy. Trace entries can record model and tool events, but reasoning only exists when the provider reports it, pattern redaction is not complete secret detection, and a background-completion event is not an archive of the entire output. Unknown pricing is not a measured zero bill.</p>
        <p className="ph-consequence"><strong>The practical consequence:</strong> keep evidence inspectable and side-effect policy explicit. Do not infer permission to ship from confident prose, a phase transition, or result.ok.</p>
        <SourceNote value="evidence-source" title="mechanics, not a verification certificate" links={[["Evidence helper", "src/engine/evidence.ts"], ["Event contract", "src/engine/events.ts"], ["Evidence limitations", "/docs.html#evidence"]]}>The runtime does not require test evidence to accept a final response. Application publication tools can enforce their own policy. Snapshots may still commit changed work at run boundaries by default; that persistence mechanism is separate from publishing a PR, sending a message, or deploying an application.</SourceNote>
      </Principle>

      <Principle id="bounds" number="07" title="Bound the work. Preserve the handoff." lead="Autonomy is more useful when it has an explicit stopping condition.">
        <p>Repeated tool calls, empty turns, and a capped response are ordinary failure modes, not reasons to create an infinite outer retry loop. Anchor can offer bounded course correction while keeping spend, cancellation, and execution deadlines visible.</p>
        <BudgetDiagram />
        <p>A command's detach threshold and its hard lifetime are different controls. A run's allowance and the provider's per-call output cap are different controls too. Usage is checked between model turns, so the last call can overshoot a run budget. A well-designed harness should expose those distinctions rather than hide them behind a single “keep trying” switch.</p>
        <p>When work remains, an agent can leave a revival handoff. That preserves the opportunity to continue without authorizing another purchase of tokens. The host decides whether the next step is a funded run, a pause, or a person.</p>
        <SourceNote value="bounds-source" title="a nudge is not a new allowance" links={[["Budget tracker", "src/engine/budgets.ts"], ["Revival planner", "src/engine/revival.ts"], ["Course correction", "/docs.html#correction"]]}>Guardrails have explicit controls and bounded recovery behavior; they cannot guarantee progress. Revival is opt-in. planRevival helps an application make its decision; the engine does not fund another run. A cancelled call also does not automatically kill every detached guest process.</SourceNote>
      </Principle>

      <section className="ph-ownership" id="ownership" aria-labelledby="ownership-title"><span className="eyebrow">THE SEAM THAT TIES IT TOGETHER</span><h2 id="ownership-title">Anchor owns the mechanics.<br /><span>You own the judgment.</span></h2><p>Generic does not mean making the host do everything. It means taking ownership where the contract is clear, and refusing to smuggle application-specific decisions into the runtime.</p><div className="ph-ownership-table-wrap" role="region" aria-label="Ownership table" tabIndex={0}><table className="ph-ownership-table"><caption>Where the responsibility belongs</caption><thead><tr><th scope="col">Concern</th><th scope="col">Anchor supplies</th><th scope="col">Your application decides</th></tr></thead><tbody>{[
        ["Behavior", "Strategy, tool, and agent contracts", "Instructions, tools, domain rules, and authorization"],
        ["Execution", "The model/tool loop and lifecycle hooks", "Model, provider, toolchain, limits, and permitted actions"],
        ["Memory", "Compaction, thread interfaces, and spill mechanisms", "Durable adapters, retention, access, and backup policy"],
        ["Delivery", "Safe-boundary inbox chaining and in-call job polling", "Producer authentication, ownership, leases, and later wake-up"],
        ["Recovery", "Snapshots, handles, pending jobs, and revival handoffs", "Restore, re-funding, idempotency, cleanup, and escalation"],
        ["Trust", "Events, tool metadata, and evidence helpers", "Trusted checks and whether anything may be published"],
      ].map(row => <tr key={row[0]}><th scope="row">{row[0]}</th><td>{row[1]}</td><td>{row[2]}</td></tr>)}</tbody></table></div><p className="ph-final-thought">The goal is not an agent that can never fail. It is a system whose behavior you can compose, whose work you can inspect, and whose next step you still control.</p></section>

      <section className="ph-next" aria-labelledby="ph-next-title"><div><span className="eyebrow">TURN THE IDEAS INTO CODE</span><h2 id="ph-next-title">Now build the agent.</h2><p>Start with the primitives, assemble the harness, then add the capabilities the task actually needs.</p></div><div><a href="/docs.html#primitives">Build from primitives <ArrowRight size={17} /></a><a href="/docs.html#assembled">Read the complete harness <ArrowRight size={17} /></a><a href={`${repo}/blob/main/DECISIONS.md`}>Follow the decision log <ArrowUpRight size={17} /></a></div></section>
    </div>
    <footer className="ph-editorial-note"><strong>A source-backed explanation, not a new guarantee.</strong><p>This guide describes the public 0.1.7 contract and the reasoning recorded in the SDK's decisions. Older decision entries include superseded designs; current implementation and the versioned API take precedence. Diagrams are conceptual. No live model or cloud sandbox is run by this page.</p></footer>
  </article></PageShell>;
}

mountPage(Philosophy);
