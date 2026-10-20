import React from "react";
import * as Tabs from "@animate-ui/react/primitives/radix-ui/tabs";
import * as Accordion from "@animate-ui/react/primitives/radix-ui/accordion";
import { Download, Plus } from "lucide-react";
import { CodeBlock, CopyButton } from "./ui.jsx";
import example from "./examples/policy-agent.mjs?raw";

const parts = Object.fromEntries(
  ["TOOL", "STRATEGY", "AGENT", "RUN"].map((name, i, names) => {
    const start = example.indexOf(`// 0${i + 1} / ${name}`);
    const end =
      i < names.length - 1
        ? example.indexOf(`// 0${i + 2} / ${names[i + 1]}`)
        : example.indexOf("// Importing the agent");
    return [name.toLowerCase(), example.slice(start, end).trim()];
  }),
);
const downloadUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(example)}`;

export function CustomAgentExample() {
  return (
    <>
      <p>
        A custom agent is a plain object. Define its behavior and tools in your
        own module, then pass it to the same runtime as the built-ins. This
        policy assistant uses demo data and needs no sandbox.
      </p>
      <dl className="agent-definitions">
        {[
          ["Strategy", "Your system prompt, phases, and startup requirements."],
          [
            "Phase",
            "A named kind of work, not a permission or an executable step.",
          ],
          ["Tool", "A schema the model sees and a handler you implement."],
          ["Agent", "A reusable name + strategy + tools bundle."],
        ].map(([term, definition]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{definition}</dd>
          </div>
        ))}
      </dl>
      <Tabs.Root defaultValue="agent" className="custom-agent-tabs">
        <Tabs.List aria-label="Custom agent example">
          {[
            ["agent", "Agent"],
            ["strategy", "Strategy"],
            ["tool", "Tool"],
            ["run", "Run"],
          ].map(([id, label]) => (
            <Tabs.Trigger key={id} value={id}>
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {[
          [
            "agent",
            "Export the bundle. It contains no model instance or per-run state.",
          ],
          [
            "strategy",
            "Implement name, phases, and systemPrompt. requiredTools checks availability at startup, not whether the model will use a tool. Include your phase goals and domain rules in the prompt.",
          ],
          [
            "tool",
            "Validate model input in the handler. content goes back to the model; meta stays structured in the evidence. Custom handlers run in your host unless they explicitly use a sandbox.",
          ],
          [
            "run",
            "Your host provides the model, task, and runtime options. Importing this agent does not call the model; running its CLI entry point does.",
          ],
        ].map(([id, explanation]) => (
          <Tabs.Content value={id} key={id}>
            <p>{explanation}</p>
            <CodeBlock
              code={parts[id]}
              filename="policy-agent.mjs"
              language="JAVASCRIPT"
            />
          </Tabs.Content>
        ))}
      </Tabs.Root>
      <div className="agent-example-download">
        <span>All tabs belong to one file.</span>
        <CopyButton text={example} label="Copy complete policy agent" />
        <a href={downloadUrl} download="policy-agent.mjs">
          Download example <Download size={14} />
        </a>
      </div>
      <Accordion.Root type="single" collapsible className="faq doc-accordion">
        <Accordion.Item value="full-example">
          <Accordion.Header>
            <Accordion.Trigger>
              Complete runnable example
              <Plus size={16} />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>
            <CodeBlock
              code={example}
              filename="policy-agent.mjs"
              language="JAVASCRIPT"
            />
            <CodeBlock
              code={`# After installing anchor-ai-sdk, save policy-agent.mjs\nexport OPENROUTER_KEY="your-key"\nnode policy-agent.mjs`}
              filename="terminal"
              language="SHELL"
            />
            <p>
              Model calls may incur cost. The small in-memory policy map is a
              fixture; replace it with your authorized data service. Handle
              input validation, authorization, timeouts, and output size in your
              own handlers.
            </p>
          </Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="strategy-contract">
          <Accordion.Header>
            <Accordion.Trigger>
              Strategy and phase interfaces
              <Plus size={16} />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>
            <div className="agent-interface-fields">
              {[
                ["name · required", "A stable name for the strategy."],
                [
                  "phases · required",
                  "An array of { id, goal, guidance? }. Use one phase if no stage labels are needed. The engine uses IDs; include domain-specific goal/guidance text in your prompt.",
                ],
                [
                  "systemPrompt · required",
                  "Receives { task, context, summary } and returns your instruction string.",
                ],
                [
                  "requiredTools · optional",
                  "Reject startup when a named tool is missing. This does not force a model call.",
                ],
                [
                  "requiresSandbox · optional",
                  "Reject startup without a sandbox. Adapter choice determines isolation.",
                ],
                [
                  "prepareContext · optional",
                  "An async (sandbox, task) hook returning context text. Explicit task.context bypasses it.",
                ],
              ].map(([field, meaning]) => (
                <div key={field}>
                  <code>{field}</code>
                  <p>{meaning}</p>
                </div>
              ))}
            </div>
          </Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="integration">
          <Accordion.Header>
            <Accordion.Trigger>
              Plug an agent into your app
              <Plus size={16} />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>
            <CodeBlock
              code={`import { runAgent } from "anchor-ai-sdk";\nimport { policyAgent } from "./policy-agent.mjs";\n\n// llm and compaction are configured by your host.\nconst result = await runAgent(\n  { task: "What is your refund policy?" },\n  { llm, compaction, agent: policyAgent },\n);`}
              filename="host.mjs"
              language="JAVASCRIPT"
            />
            <p>
              You can pass <code>strategy</code> and <code>tools</code>{" "}
              separately instead. Explicit engine options override the bundle;
              an explicit tools array replaces, rather than appends to, the
              bundle’s tools.
            </p>
            <p>
              An agent from another framework needs an adapter: map prompts to{" "}
              <code>AgentStrategy</code>, handlers to <code>Tool</code>, and any
              custom model wrapper to <code>LLMClient</code>. Anchor does not
              automatically adopt an opaque external <code>agent.run()</code>{" "}
              loop.
            </p>
          </Accordion.Content>
        </Accordion.Item>
      </Accordion.Root>
      <p className="doc-small">
        Your host still owns model credentials, authorization, durable storage,
        and decisions such as funding revival. Anchor supplies the run loop,
        tool dispatch, intrinsic control tools, and runtime guardrails.
      </p>
    </>
  );
}
