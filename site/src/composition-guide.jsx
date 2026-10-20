import React from "react";
import * as Accordion from "@animate-ui/react/primitives/radix-ui/accordion";
import { ArrowRight, Download, Plus } from "lucide-react";
import { CodeBlock, CopyButton } from "./ui.jsx";
import policySource from "./examples/policy-agent.mjs?raw";
import harnessSource from "./examples/repository-harness.mjs?raw";

const phaseStart = policySource.indexOf("export const policyPhases");
const strategyStart = policySource.indexOf("// Strategy consumes");
const phaseCode = policySource.slice(phaseStart, strategyStart).trim();
const strategyCode = policySource.slice(strategyStart, policySource.indexOf("// 03 / AGENT")).trim();
const assemblyCode = harnessSource.slice(
  harnessSource.indexOf("// 04 / HARNESS"),
  harnessSource.indexOf("function requiredEnv"),
).trim();
const harnessInstall = "npm install anchor-ai-sdk@0.1.7 @heyocomputer/hws\n# Set OPENROUTER_KEY and REPO_URL, plus the HEYO_* values from provider setup.\nnode repository-harness.mjs";

const loopExample = `import { runAgent } from "anchor-ai-sdk";
import { reviewAgent } from "./repository-harness.mjs";

// reviewAgent is { name, strategy, tools }, assembled below.
// llm and sandbox are supplied by your host, not stored in the agent.
const result = await runAgent({ task: "Investigate the retry behavior" }, {
  llm, agent: reviewAgent, sandbox,
});

// Runtime sequence (explanation, not a second loop for you to implement):
// 1. strategy.systemPrompt + thread/context + task -> model request
// 2. Model chooses tool calls -> matching tool.run(input, { sandbox, ... })
// 3. Tool content -> observations in the next model request
// 4. set_phase changes the approach label; it does not run a phase function
// 5. A final response/finish, stop condition, or budget ends this run
console.log(result.reason, result.summary, result.usage);`;

export function PrimitivesGuide() {
  return <>
    <p>The quickstart used a ready-made bundle. Now build one yourself. An agent is <strong>behavior + capabilities</strong>; a harness is the runtime wiring that lets it work with a model, resources, state, and limits. You do not need every optional feature to start.</p>
    <ol className="composition-path" aria-label="Agent composition learning path">
      {[
        ["phases", "Phases → strategy", "Name the kinds of work, then put their goals into the prompt."],
        ["custom-agents", "Tools → agent", "Implement capabilities and bundle them with the strategy."],
        ["machine", "Model + machine → run", "Supply live dependencies and let the engine execute the loop."],
        ["assembled", "State + controls → harness", "Add continuity, delivery, observability, and resource ownership."],
      ].map(([id, title, description], i) => <li key={id}><span className="composition-step">0{i + 1}</span><div><a href={`#${id}`}>{title} <ArrowRight size={14} /></a><p>{description}</p></div></li>)}
    </ol>
    <div className="composition-wiring" aria-label="How the primitives connect">
      <code>phases + systemPrompt → strategy</code>
      <code>strategy + tools → agent</code>
      <code>task + llm + agent + options → runAgent → result</code>
    </div>
    <p className="doc-small">A <code>StrategyPhase</code> is data, a <code>Tool</code> performs an operation, and the engine runs the loop. A <code>Sandbox</code> is an optional execution dependency used by machine tools—not a different kind of agent. Stores, traces, and budgets plug into run options rather than the reusable bundle.</p>
    <dl className="agent-definitions">{[
      ["Reusable", "Phase data, strategy instructions, and tool definitions belong in your agent module."],
      ["Per call", "A task, model client (LLMClient), optional sandbox, and EngineOptions configure this execution."],
      ["Across calls", "A stable thread ID and your storage/worker policies connect executions without making the agent a stateful singleton."],
    ].map(([term, definition]) => <div key={term}><dt>{term}</dt><dd>{definition}</dd></div>)}</dl>
  </>;
}

export function PhasesGuide() {
  return <>
    <h3>1. Name the kinds of work</h3>
    <p>A phase needs an <code>id</code> and <code>goal</code>, with optional <code>guidance</code>. Start with the smallest useful vocabulary. This policy assistant only needs lookup and answer; a repository agent might use understand, inspect, validate, and respond.</p>
    <CodeBlock code={phaseCode} filename="policy-agent.mjs · phases" language="JAVASCRIPT" />
    <h3>2. Make those phases part of a strategy</h3>
    <p>The strategy binds phase data to instructions. Assign the array to <code>phases</code>, and render its goals in <code>systemPrompt</code> so the model sees your intended approach. Requirements are checked at startup; they do not force a tool call or verify the answer.</p>
    <CodeBlock code={strategyCode} filename="policy-agent.mjs · strategy" language="JAVASCRIPT" />
    <div className="agent-interface-fields">
      {[
        ["phases → progress vocabulary", "The engine uses phase IDs and exposes set_phase for a multi-phase strategy by default. Calling it updates the current label and emits phase_started; it does not invoke an executable phase handler."],
        ["systemPrompt → model instructions", "The engine calls this with task, application context, and an earlier thread summary. Read the values your strategy needs. Declaring a phase goal is not a substitute for including it in the prompt."],
        ["requiredTools / requiresSandbox → startup checks", "Catch missing dependencies before model execution. These are availability checks, not per-phase permissions or proof the model used the capability."],
      ].map(([field, text]) => <div key={field}><code>{field}</code><p>{text}</p></div>)}
    </div>
    <p className="doc-small">Phases guide the approach; they are not a fixed pipeline. The model can skip, revisit, or finish from any phase. A one-phase strategy works too. For an enforced approval or release gate, implement host-side policy rather than relying on a phase label.</p>
    <a className="doc-inline-link" href="#custom-agents">Next: give this strategy a tool and assemble the agent <ArrowRight size={14} /></a>
  </>;
}

export function LoopCompositionGuide() {
  return <>
    <p>The loop is driven by model responses and tool observations, with phases describing the current approach. The strategy defines the vocabulary; the engine runs model → tools → observations → model. It does not execute the phase array from top to bottom.</p>
    <CodeBlock code={loopExample} filename="how-the-loop-connects.mjs" language="JAVASCRIPT" />
    <p className="doc-small">See <a href="#phases">phases → strategy</a> for the definition and <a href="#assembled">the assembled harness</a> for the full call. <code>startPhase</code> chooses a starting label; <code>pauseAfterPhase</code> can pause when the agent leaves a named phase. Neither makes earlier phases mandatory.</p>
  </>;
}

export function AssembledHarnessGuide() {
  return <>
    <p>Now apply the same recipe to a repository reviewer: phase data → strategy → a curated tool set → an agent. The host adds a configured provider, model client, stores, controls, and traces. This example builds its own agent rather than hiding the composition behind <code>codingAgent</code>.</p>
    <div className="composition-wiring">
      <code>reviewPhases → reviewStrategy → reviewAgent</code>
      <code>reviewAgent + model + started sandbox + state → reviewRepository</code>
    </div>
    <CodeBlock code={assemblyCode} filename="repository-harness.mjs · runtime wiring" language="JAVASCRIPT" />
    <div className="agent-interface-fields">
      {[
        ["Behavior stays reusable", "reviewAgent holds phases, a prompt, and read/search/bash/test tools. A different model or SandboxProvider does not require a new agent loop."],
        ["Runtime options add capabilities", "ThreadStore carries conversation; inbox chains new tasks; compaction bounds replay; budgets/guardrails bound execution; trace sinks journal what happened. They are independent inputs, not a giant Agent subclass."],
        ["Resource ownership stays explicit", "This recipe creates and destroys one workspace per call, reusing it inside an inbox chain. It deliberately leaves background execution off. Cross-call workspace continuity and background jobs require the retained-machine/resume policy in the dedicated guides."],
      ].map(([title, text]) => <div key={title}><code>{title}</code><p>{text}</p></div>)}
    </div>
    <Accordion.Root type="single" collapsible className="faq doc-accordion">
      <Accordion.Item value="assembled-source"><Accordion.Header><Accordion.Trigger>Complete repository harness: primitives through boot <Plus size={16} /></Accordion.Trigger></Accordion.Header><Accordion.Content>
        <CodeBlock code={harnessSource} filename="repository-harness.mjs" language="JAVASCRIPT" />
      </Accordion.Content></Accordion.Item>
    </Accordion.Root>
    <div className="agent-example-download"><span>One file: phases, strategy, agent, harness, and Heyo boot.</span><CopyButton text={harnessSource} label="Copy complete repository harness" /><a href={`data:text/javascript;charset=utf-8,${encodeURIComponent(harnessSource)}`} download="repository-harness.mjs">Download harness <Download size={14} /></a></div>
    <CodeBlock code={harnessInstall} filename="terminal" language="SHELL" />
    <p className="doc-small">Use <a href="#machine">Heyo setup</a> for credentials and an accessible toolchain image. Provision dependencies needed by the repository before asking the model to run checks. Running this file boots a cloud machine and calls a model, which may incur cost.</p>
    <p className="doc-small">The prompt's “do not edit” instruction is not a read-only security boundary: shell and test commands can write files. Host authorization, worker ownership, timeouts, trusted commands, durable store adapters, trace access/retention, and release policy remain application responsibilities. Memory stores here are demo-only. Inbox runs share a budget; top-level evidence covers the final run, so use your journal for checks across the whole chain.</p>
    <h3>Grow it one capability at a time</h3>
    <ul className="composition-next">
      <li><a href="#messages">Incoming messages</a>: authenticate producers, push queue/interject messages, and wake workers after a call ends.</li>
      <li><a href="#background">Long-running commands</a>: add retained-machine bookkeeping before enabling background execution.</li>
      <li><a href="#revival">Work beyond one budget</a>: preserve a handoff and let host policy decide whether to fund another call.</li>
      <li><a href="#evidence">Application decisions</a>: evaluate trusted evidence; a finished loop is not permission to publish.</li>
    </ul>
  </>;
}
