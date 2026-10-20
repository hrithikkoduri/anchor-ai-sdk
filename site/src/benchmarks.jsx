import React, { useState } from "react";
import { mountPage } from "./client.jsx";
import * as Tabs from "@animate-ui/react/primitives/radix-ui/tabs";
import * as Accordion from "@animate-ui/react/primitives/radix-ui/accordion";
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
import { tasks, totals, round } from "./benchmark-data.js";
import logo from "../assets/logo.svg";
import "./styles.css";
import "./pages.css";
import "./typography.css";
import "./theme.css";

const source = `${repo}/blob/main/evals/benchmarks/swe-bench`;
const artifact = (arm, file) =>
  `${source}/results/${arm === "anchor" ? round.anchorPath : round.miniPath}/${file}`;
const number = (value) =>
  value == null ? "Not reported" : value.toLocaleString("en-US");
const dollars = (value) =>
  value == null ? "Not reported" : `$${value.toFixed(4)}`;
const seconds = (value) =>
  value == null
    ? "Not reported"
    : `${Math.round(value).toLocaleString("en-US")}s`;
const metrics = [
  {
    id: "resolution",
    label: "Resolution",
    unit: "RESOLVED / 10 TASKS",
    a: 9,
    b: 9,
    aLabel: "9/10",
    bLabel: "9/10",
    note: "Anchor: one unresolved patch. Mini: one empty patch after extraction failed. Both published grader reports record nine resolved tasks.",
  },
  {
    id: "time",
    label: "Task wall time",
    unit: "SUM OF RECORDED TASK SECONDS",
    a: totals.anchor.seconds,
    b: totals.mini.seconds,
    aLabel: seconds(totals.anchor.seconds),
    bLabel: seconds(totals.mini.seconds),
    note: "These are summed task times, not elapsed batch duration or a controlled speed guarantee. Boot, execution, concurrency, and different budgets affect interpretation.",
  },
  {
    id: "usage",
    label: "Usage",
    unit: "RECORDED TOKENS / NOT A COST COMPARISON",
    a: totals.anchor.tokens,
    b: null,
    aLabel: "11.36M",
    bLabel: "Not reported",
    note: "Anchor records 11,363,962 tokens and $4.3162 cost. Mini's result records omit usage; a run-summary totalUsd of 0 is not evidence that it was free. No cost/token ratio is claimed.",
  },
];

function Outcome({ resolved, empty }) {
  return (
    <span className={`outcome ${resolved ? "resolved" : "unresolved"}`}>
      {resolved ? <Check size={11} /> : <span>—</span>}
      {resolved ? "Resolved" : empty ? "No patch" : "Unresolved"}
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
          Completed Parasail GLM 5.3 ten-task results. Missing mini usage is
          shown as not reported, never zero.
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
                    {["Result", "Steps", "Task time", "Tokens", "USD"].map(
                      (label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ),
                    )}
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
              <th scope="col">Mini $</th>
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
                      <Outcome
                        resolved={task[arm][0]}
                        empty={
                          arm === "mini" && task.miniOutcome === "empty_patch"
                        }
                      />
                    </td>
                    <td>{number(task[arm][1])}</td>
                    <td>{seconds(task[arm][2])}</td>
                    <td>{number(task[arm][3])}</td>
                    <td>{dollars(task[arm][4])}</td>
                  </React.Fragment>
                ))
              ) : (
                <>
                  <td>
                    <Outcome resolved={task.anchor[0]} />
                  </td>
                  <td>
                    <Outcome
                      resolved={task.mini[0]}
                      empty={task.miniOutcome === "empty_patch"}
                    />
                  </td>
                  <td>{dollars(task.anchor[4])}</td>
                  <td>Not reported</td>
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
                  <td>9/10</td>
                  <td>{number(totals[arm].steps)}</td>
                  <td>{seconds(totals[arm].seconds)}</td>
                  <td>{number(totals[arm].tokens)}</td>
                  <td>{dollars(totals[arm].usd)}</td>
                </React.Fragment>
              ))
            ) : (
              <>
                <td>9/10</td>
                <td>9/10</td>
                <td>$4.3162</td>
                <td>Not reported</td>
              </>
            )}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function Benchmarks() {
  const [metric, setMetric] = useState("resolution");
  return (
    <PageShell page="benchmarks">
      <section className="container bench-hero">
        <div className="bench-hero-copy">
          <span className="eyebrow">
            <span className="cross">+</span> COMPLETED EVAL / PARASAIL GLM 5.3
          </span>
          <h1>
            Nine of ten.
            <br />
            <span>Both records open.</span>
          </h1>
          <p>
            Anchor and mini-swe-agent each resolved nine tasks in the published
            Lite-10 artifacts. The different failures and setup limits matter as
            much as the aggregate.
          </p>
          <div className="round-tag">
            <span className="status-dot" /> COMPLETED RECORDS{" "}
            <span>19–20 OCT 2026</span>
          </div>
          <a className="text-link" href="#results">
            Every task, every result <ArrowRight size={15} />
          </a>
        </div>
        <div className="benchmark-dashboard">
          <div className="dashboard-title">
            <FlaskConical size={14} />
            <span>SWE-BENCH LITE / PARASAIL GLM 5.3</span>
            <span className="dashboard-status">OFFICIAL GRADER</span>
          </div>
          <div className="scoreboard">
            <div>
              <img src={logo} alt="" />
              <span>Anchor</span>
              <strong>
                9<span>/10</span>
              </strong>
            </div>
            <span className="scoreboard-equal">=</span>
            <div>
              <GitBranch size={20} />
              <span>mini-swe-agent</span>
              <strong>
                9<span>/10</span>
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
                ].map(([label, value, display, arm]) => (
                  <div className="dashboard-bar-row" key={arm}>
                    <div>
                      <span>{label}</span>
                      <strong>{display}</strong>
                    </div>
                    {value != null && (
                      <div className="dashboard-bar-track">
                        <div
                          className={`dashboard-bar ${arm}`}
                          style={{
                            width: `${(value / (m.id === "resolution" ? 10 : Math.max(m.a ?? 0, m.b ?? 0))) * 100}%`,
                          }}
                        />
                      </div>
                    )}
                  </div>
                ))}
                <p>{m.note}</p>
              </Tabs.Content>
            ))}
          </Tabs.Root>
          <div className="dashboard-bottom">
            <ShieldCheck size={12} /> Parasail · temperature 0 · seed 42 ·
            different budgets
          </div>
        </div>
      </section>
      <div className="container benchmark-disclosure">
        <span>READ THE FINE PRINT</span>
        <p>
          Ten selected Lite tasks, not the full benchmark. Both records name{" "}
          <code>zai-org/GLM-5.3</code> on Parasail and Docker-backed task
          environments. Anchor's published limits are 120 steps / 25M tokens;
          mini uses its own 250-step / $3 loop. These are not identical budget
          policies, and fixed sampling parameters do not establish statistical
          significance or general superiority.
        </p>
      </div>

      <section className="bench-results-section" id="results">
        <div className="container">
          <div className="section-heading">
            <div>
              <span className="eyebrow">
                <span className="cross">+</span> 01 / THE COMPLETED LEDGER
              </span>
              <h2>
                Read the patches.
                <br />
                Not just the score.
              </h2>
            </div>
            <a
              className="doc-inline-link"
              href={artifact("anchor", "manifest.json")}
            >
              Anchor manifest <ArrowUpRight size={13} />
            </a>
          </div>
          <Tabs.Root defaultValue="summary" className="ledger-tabs">
            <div className="ledger-toolbar">
              <div>
                <span className="status-dot" /> zai-org/GLM-5.3{" "}
                <span>10 TASKS / PARASAIL</span>
              </div>
              <Tabs.List aria-label="Results detail">
                <Tabs.Trigger value="summary">Outcomes</Tabs.Trigger>
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
              <i /> Different stopping paths.
            </span>
            <p>
              Mini has nine reported step counts (454 in total); the
              extraction-failed task has no step count. Its complete step
              aggregate, token usage, and cost are not reported. Task times are
              rounded here; source records retain milliseconds.
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
            Equal resolution.
            <br />
            Different failure paths.
          </h2>
        </div>
        <div className="takeaway-list">
          <div>
            <span>01</span>
            <div>
              <h3>Anchor: sympy remained unresolved.</h3>
              <p>
                The published patch did not satisfy the official tests. The
                record explains the missing relational printer; a local test
                pass was not enough.
              </p>
            </div>
          </div>
          <div>
            <span>02</span>
            <div>
              <h3>Mini: matplotlib produced no extracted patch.</h3>
              <p>
                The runner records a git index.lock error during patch
                extraction. This is a pipeline failure/empty patch, not evidence
                that the model submitted a patch which failed the hidden tests.
              </p>
            </div>
          </div>
          <div>
            <span>03</span>
            <div>
              <h3>No cost-efficiency ratio for this round.</h3>
              <p>
                Anchor records $4.3162 and 11.36M tokens. Mini does not report
                comparable usage. The earlier $0.60 / ≈$1.99 comparison belongs
                to an older OpenRouter baseline and is not reused here.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="benchmark-method">
        <div className="container method-grid">
          <div>
            <span className="eyebrow">
              <span className="cross">+</span> 03 / SOURCE ARTIFACTS
            </span>
            <h2>
              Two records.
              <br />
              Inspectable outcomes.
            </h2>
            <p>
              Each arm has results, verdicts, manifests, and grading reports.
              Anchor also includes engine traces; mini does not emit Anchor's
              event schema.
            </p>
            <div className="artifact-links">
              <a href={artifact("anchor", "README.md")}>
                Anchor record <ArrowUpRight size={13} />
              </a>
              <a href={artifact("mini", "README.md")}>
                Mini record <ArrowUpRight size={13} />
              </a>
              <a href={artifact("anchor", "grading/glm-5.3-parasail.json")}>
                Anchor grader <ArrowUpRight size={13} />
              </a>
              <a href={artifact("mini", "grading/mini.json")}>
                Mini grader <ArrowUpRight size={13} />
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
                "Both run records identify Docker-backed tasks and the same direct Parasail model endpoint with temperature 0 and seed 42. They ran at different times and used different step/budget policies; do not describe this as a perfectly controlled single-variable experiment.",
              ],
              [
                "accounting",
                "The accounting caveat",
                "Anchor per-task results contain usage and recorded cost. Mini per-task results omit usage and its run summary contains a zero totalUsd; that is missing accounting, not a measured zero bill. No new relative token/cost claim is supported.",
              ],
              [
                "grading",
                "What was graded",
                "Anchor's report records nine resolved and one unresolved task. Mini's report records nine resolved and one empty patch. The manifest patch hashes can be checked against the saved patches; runtime completion is not the grading verdict. Anchor's seaborn patch resolved despite ending at max_steps.",
              ],
              [
                "history",
                "Older OpenRouter baseline",
                "The repository separately preserves an earlier 7/10 vs 7/10 run at $0.6036 vs estimated $1.9871. That baseline used different settings/accounting and is historical context only, not the cost of these completed Parasail records.",
              ],
              [
                "limits",
                "What these records cannot establish",
                "A selected ten-task sample with differing budgets, one recorded extraction failure, and incomplete cost accounting does not establish statistical significance, general task accuracy, provider equivalence, or cost superiority. These artifacts are a record of this evaluation, not a certification of future runs.",
              ],
            ].map(([id, title, text]) => (
              <Accordion.Item key={id} value={id}>
                <Accordion.Header>
                  <Accordion.Trigger>
                    {title}
                    <Plus size={16} />
                  </Accordion.Trigger>
                </Accordion.Header>
                <Accordion.Content>
                  <p>{text}</p>
                  {id === "history" && (
                    <a
                      className="doc-inline-link"
                      href={`${source}/results/comparison.md`}
                    >
                      Historical comparison <ArrowUpRight size={13} />
                    </a>
                  )}
                </Accordion.Content>
              </Accordion.Item>
            ))}
          </Accordion.Root>
        </div>
      </section>

      <section className="container reproduce-section">
        <div>
          <span className="eyebrow">
            <span className="cross">+</span> 04 / RUN YOUR OWN EVAL
          </span>
          <h2>
            Use the setup guide.
            <br />
            Keep your own records.
          </h2>
          <p>
            The commands start new runs on current code. Install eval
            dependencies and prepare task images first. Changing budgets or
            SDK/model versions changes the experiment; new outcomes are not
            guaranteed to match these artifacts.
          </p>
          <a className="doc-inline-link" href={`${source}/README.md`}>
            Environment & grading guide <ArrowUpRight size={13} />
          </a>
        </div>
        <CodeBlock
          code={`# From the repository root, after eval setup. Cloud/model calls can cost money.
# PARASAIL_API_KEY must be set. Docker must be running and on PATH.
npm run eval --prefix evals -- \\
  --tasks benchmarks/swe-bench/data/swebench-lite-10.jsonl \\
  --provider docker --arm anchor --llm parasail \\
  --max-steps 120 --max-tokens 25000000

# Mini has its own loop/limits; consult the current runner's options.
npm run eval --prefix evals -- \\
  --tasks benchmarks/swe-bench/data/swebench-lite-10.jsonl \\
  --provider docker --arm mini --llm parasail`}
          filename="run-benchmark.sh"
          language="SHELL"
        />
      </section>
      <div className="container benchmark-cta">
        <span>
          <Clock3 size={17} /> Evaluate the harness on your own workload.
        </span>
        <a className="button primary" href="/docs.html#quickstart">
          Build your agent <ArrowUpRight size={16} />
        </a>
      </div>
    </PageShell>
  );
}
mountPage(Benchmarks);
