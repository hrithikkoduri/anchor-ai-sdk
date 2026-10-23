import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import * as Tabs from "@animate-ui/react/primitives/radix-ui/tabs";
import * as Accordion from "@animate-ui/react/primitives/radix-ui/accordion";
import { motion } from "motion/react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Clock3,
  FlaskConical,
  GitBranch,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { CodeBlock, PageShell, repo } from "./ui.jsx";
import { tasks, totals } from "./benchmark-data.js";
import logo from "../assets/logo.svg";
import "./styles.css";
import "./pages.css";
import "./typography.css";
import "./theme.css";

const source = `${repo}/blob/main/evals/benchmarks/swe-bench`;
const number = (n) => n.toLocaleString("en-US");
const metrics = [
  {
    id: "cost",
    label: "Run cost",
    unit: "USD / ALL 10 TASKS",
    a: totals.anchor.usd,
    b: totals.mini.usd,
    aLabel: "$0.6036",
    bLabel: "≈$1.9871",
    note: "Anchor: provider usage at live catalog rates. Mini: estimated tokens priced at model rates.",
  },
  {
    id: "tokens",
    label: "Tokens",
    unit: "TOKENS / ALL 10 TASKS",
    a: totals.anchor.tokens,
    b: totals.mini.tokens,
    aLabel: "5.28M",
    bLabel: "≈16.99M",
    note: "Mini tokens are estimated from serialized history ÷ 4. These are not equivalent accounting methods.",
  },
  {
    id: "time",
    label: "Wall time",
    unit: "SECONDS / ALL 10 TASKS",
    a: totals.anchor.seconds,
    b: totals.mini.seconds,
    aLabel: "4,137s",
    bLabel: "2,182s",
    note: "The trade-off: Anchor took about 1.9× the wall time in this round. Both arms used emulated amd64 containers.",
  },
];

function Outcome({ resolved }) {
  return (
    <span className={`outcome ${resolved ? "resolved" : "unresolved"}`}>
      {resolved ? <Check size={11} /> : <span>—</span>}
      {resolved ? "Resolved" : "Unresolved"}
    </span>
  );
}

function Ledger({ full }) {
  return (
    <div
      className="ledger-scroll"
      tabIndex={0}
      role="region"
      aria-label={
        full
          ? "Full benchmark ledger, scroll horizontally for all columns"
          : "Task outcome and cost comparison"
      }
    >
      <table className={`ledger ${full ? "full-ledger" : ""}`}>
        <caption className="sr-only">
          Round 1 SWE-bench Lite results for ten tasks. Mini token and cost
          values are estimates.
        </caption>
        <thead>
          {full ? (
            <>
              <tr>
                <th rowSpan={2} scope="col">
                  Task
                </th>
                <th colSpan={5} scope="colgroup" className="anchor-col">
                  Anchor
                </th>
                <th colSpan={5} scope="colgroup">
                  mini-swe-agent
                </th>
              </tr>
              <tr>
                {["Anchor", "Mini"].map((arm) => (
                  <React.Fragment key={arm}>
                    {[
                      "Result",
                      "Steps",
                      "Time",
                      arm === "Mini" ? "Tokens ≈" : "Tokens",
                      arm === "Mini" ? "USD ≈" : "USD",
                    ].map((name) => (
                      <th key={name} scope="col">
                        {name}
                      </th>
                    ))}
                  </React.Fragment>
                ))}
              </tr>
            </>
          ) : (
            <tr>
              <th scope="col">Task</th>
              <th scope="col" className="anchor-col">
                Anchor
              </th>
              <th scope="col">mini-swe-agent</th>
              <th scope="col" className="anchor-col">
                Anchor $
              </th>
              <th scope="col">Mini $ ≈</th>
            </tr>
          )}
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.id}
              className={task.anchor[0] !== task.mini[0] ? "divergent" : ""}
            >
              <th scope="row">
                <span className="task-indicator" />
                {task.id}
              </th>
              {full ? (
                ["anchor", "mini"].map((arm) => (
                  <React.Fragment key={arm}>
                    <td>
                      <Outcome resolved={task[arm][0]} />
                    </td>
                    <td>{task[arm][1]}</td>
                    <td>{task[arm][2]}s</td>
                    <td>
                      {arm === "mini" ? "≈" : ""}
                      {number(task[arm][3])}
                    </td>
                    <td>
                      {arm === "mini" ? "≈" : ""}${task[arm][4].toFixed(4)}
                    </td>
                  </React.Fragment>
                ))
              ) : (
                <>
                  <td>
                    <Outcome resolved={task.anchor[0]} />
                  </td>
                  <td>
                    <Outcome resolved={task.mini[0]} />
                  </td>
                  <td>${task.anchor[4].toFixed(4)}</td>
                  <td>≈${task.mini[4].toFixed(4)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">TOTAL / 10 TASKS</th>
            {full ? (
              ["anchor", "mini"].map((arm) => (
                <React.Fragment key={arm}>
                  <td>7/10</td>
                  <td>{totals[arm].steps}</td>
                  <td>{number(totals[arm].seconds)}s</td>
                  <td>
                    {arm === "mini" ? "≈" : ""}
                    {number(totals[arm].tokens)}
                  </td>
                  <td>
                    {arm === "mini" ? "≈" : ""}${totals[arm].usd.toFixed(4)}
                  </td>
                </React.Fragment>
              ))
            ) : (
              <>
                <td>7/10</td>
                <td>7/10</td>
                <td>$0.6036</td>
                <td>≈$1.9871</td>
              </>
            )}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Benchmarks() {
  const [metric, setMetric] = useState("cost");
  return (
    <PageShell page="benchmarks">
      <section className="container bench-hero">
        <div className="bench-hero-copy">
          <span className="eyebrow">
            <span className="cross">+</span> BENCHMARKS / ROUND 01
          </span>
          <h1>
            Same score.
            <br />
            <span>Different ledger.</span>
          </h1>
          <p>
            We put the harness on the official grader.
            <br />
            Here’s what it solved, spent, and didn’t.
          </p>
          <div className="round-tag">
            <span className="status-dot" /> PUBLISHED BASELINE{" "}
            <span>18 OCT 2026</span>
          </div>
          <a className="text-link" href="#results">
            Every task, every result <ArrowRight size={15} />
          </a>
        </div>
        <div className="benchmark-dashboard">
          <div className="dashboard-title">
            <FlaskConical size={14} />
            <span>SWE-BENCH LITE / GLM 5.3</span>
            <span className="dashboard-status">OFFICIAL GRADER</span>
          </div>
          <div className="scoreboard">
            <div>
              <img src={logo} alt="" />
              <span>Anchor</span>
              <strong>
                7<span>/10</span>
              </strong>
            </div>
            <span className="scoreboard-equal">=</span>
            <div>
              <GitBranch size={20} />
              <span>mini-swe-agent</span>
              <strong>
                7<span>/10</span>
              </strong>
            </div>
          </div>
          <Tabs.Root value={metric} onValueChange={setMetric}>
            <Tabs.List className="metric-tabs" aria-label="Comparison metric">
              {metrics.map((m) => (
                <Tabs.Trigger key={m.id} value={m.id}>
                  {m.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            {metrics.map((m) => (
              <Tabs.Content key={m.id} value={m.id} className="metric-panel">
                <span className="metric-unit">{m.unit}</span>
                {[
                  ["Anchor", m.a, m.aLabel, "anchor"],
                  ["mini-swe-agent", m.b, m.bLabel, "mini"],
                ].map(([name, value, label, arm]) => (
                  <div className="dashboard-bar-row" key={arm}>
                    <div>
                      <span>{name}</span>
                      <strong>{label}</strong>
                    </div>
                    <div className="dashboard-bar-track">
                      <motion.div
                        className={`dashboard-bar ${arm}`}
                        initial={{ opacity: 0.7 }}
                        animate={{ opacity: 1 }}
                        style={{
                          width: `${(value / Math.max(m.a, m.b)) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
                <p>{m.note}</p>
              </Tabs.Content>
            ))}
          </Tabs.Root>
          <div className="dashboard-bottom">
            <ShieldCheck size={12} /> Same images. Same model. Same grader.
          </div>
        </div>
      </section>
      <div className="container benchmark-disclosure">
        <span>READ THE FINE PRINT</span>
        <p>
          Round 01 is the 18 October published baseline: a deterministic
          10-task subset, one per repository — not the full SWE-bench Lite set.
          Mini’s cost and tokens are estimates. The latest complete harness
          round is v0.1.7; the v0.1.8 round was interrupted. No v0.1.8 score is
          claimed here.
        </p>
      </div>

      <section className="bench-results-section" id="results">
        <div className="container">
          <div className="section-heading">
            <div>
              <span className="eyebrow">
                <span className="cross">+</span> 01 / THE COMPLETE LEDGER
              </span>
              <h2>
                No aggregate
                <br />
                without the details.
              </h2>
            </div>
            <a
              className="doc-inline-link"
              href={`${source}/results/comparison.md`}
            >
              View source data <ArrowUpRight size={13} />
            </a>
          </div>
          <Tabs.Root defaultValue="summary" className="ledger-tabs">
            <div className="ledger-toolbar">
              <div>
                <span className="status-dot" /> z-ai/glm-5.3{" "}
                <span>10 TASKS</span>
              </div>
              <Tabs.List aria-label="Results detail">
                <Tabs.Trigger value="summary">Outcome & cost</Tabs.Trigger>
                <Tabs.Trigger value="full">Full ledger</Tabs.Trigger>
              </Tabs.List>
            </div>
            <Tabs.Content value="summary">
              <Ledger full={false} />
            </Tabs.Content>
            <Tabs.Content value="full">
              <Ledger full />
            </Tabs.Content>
          </Tabs.Root>
          <div className="ledger-footnote">
            <span>
              <i /> Different outcomes — one task each.
            </span>
            <p>
              Mini values marked ≈ are estimates. Totals reflect the published
              source; rounded rows may not sum exactly. On narrow screens,
              scroll the table to inspect every column.
            </p>
          </div>
        </div>
      </section>

      <section className="container benchmark-takeaways">
        <div>
          <span className="eyebrow">
            <span className="cross">+</span> 02 / THE HONEST READ
          </span>
          <h2>
            A smaller bill.
            <br />
            Not a clean sweep.
          </h2>
        </div>
        <div className="takeaway-list">
          <div>
            <span>01</span>
            <div>
              <h3>Equal resolution. Different wins.</h3>
              <p>
                Anchor resolved matplotlib-18869; mini resolved seaborn-2848.
                Flask-4045 and sympy-11400 stayed unresolved for both.
              </p>
            </div>
          </div>
          <div>
            <span>02</span>
            <div>
              <h3>About a third of the estimated cost.</h3>
              <p>
                $0.60 vs ≈$1.99 across this subset. The accounting methods
                differ, so the ratio is indicative — not an exact like-for-like
                billing claim.
              </p>
            </div>
          </div>
          <div>
            <span>03</span>
            <div>
              <h3>Wall time went the other way.</h3>
              <p>
                Anchor took 4,137s total vs mini’s 2,182s. This round doesn’t
                establish why, and we don’t trade a latency loss for a hidden
                asterisk.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="benchmark-method">
        <div className="container method-grid">
          <div>
            <span className="eyebrow">
              <span className="cross">+</span> 03 / REPRODUCIBLE, NOT MYSTERIOUS
            </span>
            <h2>
              Open the hood.
              <br />
              Check our work.
            </h2>
            <p>
              Published results, official verdicts, and the runner are all in
              the repository.
            </p>
            <div className="artifact-links">
              <a href={`${source}/results/comparison.md`}>
                comparison.md <ArrowUpRight size={13} />
              </a>
              <a href={`${source}/results/verdicts.jsonl`}>
                verdicts.jsonl <ArrowUpRight size={13} />
              </a>
            </div>
          </div>
          <Accordion.Root
            type="single"
            collapsible
            defaultValue="setup"
            className="faq method-faq"
          >
            {[
              [
                "setup",
                "The environment",
                "Both arms used official amd64 task images, emulated on Apple Silicon. Patches were extracted by the same runner and judged by the official SWE-bench grader.",
              ],
              [
                "baseline",
                "The baseline agent",
                "mini-swe-agent ran through its Python bindings with its SWE-bench template in non-interactive mode. Its environment management was bypassed so both arms used the same task-container setup.",
              ],
              [
                "accounting",
                "The accounting caveat",
                "Anchor tokens came from provider-reported usage and costs from live catalog rates. Mini tokens were estimated from serialized history divided by four, then priced from that estimate because litellm had no GLM 5.3 pricing entry.",
              ],
              [
                "limits",
                "What this round cannot tell you",
                "Ten tasks, one model, one run per arm is not enough to claim statistical significance or performance across models and workloads. Routing, stochastic generation, accounting estimates, and emulation constrain interpretation. No newer round is claimed here without published results.",
              ],
            ].map(([id, title, body]) => (
              <Accordion.Item key={id} value={id}>
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
        </div>
      </section>

      <section className="container reproduce-section">
        <div>
          <span className="eyebrow">
            <span className="cross">+</span> 04 / RUN YOUR OWN ROUND
          </span>
          <h2>
            Don’t take the chart
            <br />
            at face value.
          </h2>
          <p>
            These commands start new runs on the current code, not an exact
            recreation of the historical score. Build the SDK, install eval
            dependencies, and follow the setup guide first.
          </p>
          <a className="doc-inline-link" href={`${source}/README.md`}>
            Environment & grading guide <ArrowUpRight size={13} />
          </a>
        </div>
        <CodeBlock
          code={`# From the repository root, after eval setup\n# Docker must be running and on PATH.\nnpm run eval --prefix evals -- \\\n  --tasks benchmarks/swe-bench/data/swebench-lite-10.jsonl \\\n  --provider docker --arm anchor \\\n  --model z-ai/glm-5.3 --max-steps 60\n\n# Baseline: same task subset and model\nnpm run eval --prefix evals -- \\\n  --tasks benchmarks/swe-bench/data/swebench-lite-10.jsonl \\\n  --provider docker --arm mini \\\n  --model z-ai/glm-5.3`}
          filename="run-benchmark.sh"
          language="SHELL"
        />
      </section>
      <div className="container benchmark-cta">
        <span>
          <Clock3 size={17} /> Measure the harness against your workload.
        </span>
        <a className="button primary" href="/docs.html#quickstart">
          Build your agent <ArrowUpRight size={16} />
        </a>
      </div>
    </PageShell>
  );
}

createRoot(document.getElementById("root")).render(<Benchmarks />);
