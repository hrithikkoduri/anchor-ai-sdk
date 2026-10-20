import React from "react";
import * as Tabs from "@animate-ui/react/primitives/radix-ui/tabs";
import { ArrowDown, ArrowRight, BrainCircuit, Check, FileText, Folder, GitBranch, Layers, Play, ShieldCheck, Terminal } from "lucide-react";

export function PhilosophyCover() {
  return <figure className="ph-cover" aria-label="The model reasons; Anchor connects its actions to an execution environment">
    <div className="ph-cover-model"><BrainCircuit size={26} /><div><strong>The model</strong><span>reasons about the task</span></div></div>
    <div className="ph-cover-connector"><span /> <ArrowDown size={17} /></div>
    <div className="ph-cover-engine"><div className="ph-cover-engine-label"><span className="status-dot" /> THE HARNESS</div><div className="ph-cover-loop"><span>Context</span><ArrowRight size={15} /><span>Action</span><ArrowRight size={15} /><span>Observation</span></div><div className="ph-cover-feedback">↳ make the next turn informed, not isolated ↵</div></div>
    <div className="ph-cover-connector"><span /> <ArrowDown size={17} /></div>
    <div className="ph-cover-world"><span><Folder size={18} />Workspace</span><span><FileText size={18} />State</span><span><GitBranch size={18} />Continuity</span></div>
    <figcaption>A mental model of the harness—not a live execution trace.</figcaption>
  </figure>;
}

export function CompositionDiagram() {
  return <figure className="ph-figure ph-composition">
    <div className="ph-assembly-inputs"><div><span className="ph-diagram-label">BEHAVIOR</span><strong>Prompt + phases</strong><span>AgentStrategy</span></div><span className="ph-join">+</span><div><span className="ph-diagram-label">CAPABILITIES</span><strong>Schema + handler</strong><span>Tool[]</span></div><ArrowRight className="ph-assembly-arrow" size={21} /><div className="ph-assembly-agent"><span className="ph-diagram-label">REUSABLE BUNDLE</span><strong>Agent</strong><span>strategy + tools</span></div></div>
    <div className="ph-assembly-wire"><ArrowDown size={20} /><span>add live dependencies when you run</span></div>
    <div className="ph-run-equation"><span>task</span><span>llm</span><span>agent</span><span>options</span><ArrowRight size={18} /><strong>runAgent</strong><ArrowRight size={18} /><span>result + events</span></div>
    <figcaption>The bundle describes what the agent is. The run supplies the model, optional machine, state, and execution controls.</figcaption>
  </figure>;
}

const phaseExamples = [
  { id: "inspect", title: "Investigate", path: ["understand", "act", "validate", "respond"], detail: "A coding task might inspect the failure, act, run a check, and explain what happened." },
  { id: "revisit", title: "Revisit", path: ["understand", "act", "validate", "act", "respond"], detail: "An observation can send the agent back to act. A phase label does not forbid revisiting the work." },
  { id: "answer", title: "Just answer", path: ["respond"], detail: "A direct explanation may finish without editing a file or visiting every phase. That can be the right outcome." },
];

export function PhaseDiagram() {
  return <figure className="ph-figure ph-phase-figure">
    <Tabs.Root defaultValue="inspect" className="ph-example-tabs"><Tabs.List aria-label="Illustrative approaches, not enforced phase sequences">{phaseExamples.map(example => <Tabs.Trigger value={example.id} key={example.id}>{example.title}</Tabs.Trigger>)}</Tabs.List>{phaseExamples.map(example => <Tabs.Content value={example.id} key={example.id}><div className="ph-phase-route" aria-label={example.title + ": " + example.path.join(" to ")}>{example.path.map((phase, index) => <React.Fragment key={index}>{index > 0 && <ArrowRight size={17} />}<span className={phase === "respond" ? "ph-phase-response" : ""}>{phase}</span></React.Fragment>)}</div><p>{example.detail}</p></Tabs.Content>)}</Tabs.Root>
    <figcaption>Illustrative paths through an approach. These controls explain the idea; they do not run an agent or define legal transitions.</figcaption>
  </figure>;
}

export function SandboxDiagram() {
  return <figure className="ph-figure ph-sandbox-figure"><div className="ph-tool-orbit"><span><Terminal size={17} />bash</span><span><FileText size={17} />read_file</span><span><Play size={17} />run_tests</span></div><div className="ph-sandbox-wires"><ArrowDown /><ArrowDown /><ArrowDown /></div><div className="ph-machine"><div className="ph-machine-header"><Folder size={18} /><strong>One shared execution environment</strong></div><div className="ph-machine-content"><div><span className="ph-diagram-label">WORKSPACE</span><code>repository files</code><code>.anchor/notes.md</code><span>agent-authored notes, not automatic memory</span></div><div><span className="ph-diagram-label">SCRATCH & EXECUTION</span><code>tool-output artifacts</code><code>deadline-bound commands</code><span>results the next turn can inspect</span></div></div></div><div className="ph-provider-seam"><span>Sandbox contract</span><span>≠</span><span>identical provider guarantees</span></div><figcaption>Machine tools share context through a sandbox. API-only agents need not have one; a local sandbox is not an isolation boundary.</figcaption></figure>;
}

export function MemoryDiagram() {
  return <figure className="ph-figure ph-memory-figure"><div className="ph-memory-layers"><div className="ph-memory-working"><span className="ph-diagram-label">WHAT THE MODEL SEES NOW</span><Layers size={22} /><h4>Working context</h4><p>Task, current instructions, recent observations, and a summary of earlier turns.</p><span className="ph-memory-action">bounded replay · compaction</span></div><div><span className="ph-diagram-label">CONVERSATION CONTINUITY</span><FileText size={22} /><h4>Thread state</h4><p>Stored conversation and runtime facts, with the summary and phase supplied by the run.</p><span className="ph-memory-action">load / persist with ThreadStore</span></div><div><span className="ph-diagram-label">A PLACE TO RETURN TO</span><Folder size={22} /><h4>Workspace artifacts</h4><p>Notes the agent writes, files it changes, and full-output spills when they succeed.</p><span className="ph-memory-action">read files · retain / checkpoint</span></div></div><figcaption>These are different stores of information, not three names for a bigger prompt. Their persistence depends on the adapters and lifecycle you configure.</figcaption></figure>;
}

export function ContinuityDiagram() {
  return <figure className="ph-figure ph-continuity-figure"><div className="ph-chain-label"><span className="status-dot" /> ONE runAgent CALL · SHARED ALLOWANCE</div><div className="ph-chain-runs"><div><span className="ph-diagram-label">CURRENT TASK</span><strong>Run A</strong></div><div className="ph-boundary"><span>safe boundary</span><ArrowRight size={23} /></div><div><span className="ph-diagram-label">CLAIMED INBOX BATCH</span><strong>Run B</strong></div></div><div className="ph-job-lane"><Terminal size={16} /><span>A pending command can travel with the chain</span><ArrowRight size={20} /></div><div className="ph-call-boundary"><span>call returns</span><ArrowDown size={18} /></div><div className="ph-host-continuation"><GitBranch size={23} /><div><strong>The next wake-up belongs to the host</strong><p>Persist state and pendingJobs; restore the machine; supply resumeJobs when another worker calls the engine.</p></div></div><figcaption>Schematic, not a promise that every batch runs: cancellation, errors, pause, exhausted allowance, and the chain's safeguards can stop continuation.</figcaption></figure>;
}

export function EvidenceDiagram() {
  return <figure className="ph-figure ph-evidence-figure"><div className="ph-evidence-inputs"><div><BrainCircuit size={21} /><h4>“I&apos;m done.”</h4><p>A final response or finish call can end the run.</p><code>reason: "finished"</code></div><span className="ph-not-equal">≠</span><div><ShieldCheck size={21} /><h4>Permission to publish</h4><p>A decision about authority, trusted checks, and acceptable risk.</p><span className="ph-policy-tag">application policy</span></div></div><div className="ph-evidence-record"><FileText size={19} /><div><strong>Evidence is an input to that decision.</strong><p>Tool status, command outcome, and an optional post-run tree hash—not a correctness certificate.</p></div><Check size={19} /></div><figcaption>The engine can record what happened without claiming that it proves what your application needs.</figcaption></figure>;
}

export function BudgetDiagram() {
  return <figure className="ph-figure ph-bounds-figure"><div><span className="ph-diagram-label">THE MODEL GETS ROOM TO REASON</span><div className="ph-bounds-loop"><span>attempt</span><ArrowRight size={18} /><span>observation</span><ArrowRight size={18} /><span>adjust</span></div></div><div className="ph-bounds-fence"><strong>Inside explicit limits</strong><span>turns · usage · command deadlines · cancellation</span></div><div className="ph-revival-choice"><ArrowDown size={20} /><div><strong>Preserve a handoff</strong><span>then let the application choose: continue, pause, or escalate</span></div></div><figcaption>Corrections are bounded assistance. Revival records remaining work; it does not authorize a new allowance.</figcaption></figure>;
}
