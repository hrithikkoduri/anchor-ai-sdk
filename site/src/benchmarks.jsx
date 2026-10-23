import React from "react";
import { createRoot } from "react-dom/client";
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
import { rounds, sweLiteDeepSeek } from "./benchmark-data.js";
import logo from "../assets/logo.svg";
import "./styles.css";
import "./pages.css";
import "./typography.css";
import "./theme.css";

const source = `${repo}/blob/main/evals/results/v0.1.7-2fbc92b`;
const number = (n) => (n == null ? "—" : n.toLocaleString("en-US"));
const percent = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const money = (n) => (n == null ? "—" : `$${n.toFixed(2)}`);

function Outcome({ reward, status }) {
  const resolved = reward === 1;
  const label =
    status === "failed"
      ? "Failed"
      : resolved
        ? "Resolved"
        : status === "completed"
          ? "Unresolved"
          : status;
  return (
    <span className={`outcome ${resolved ? "resolved" : "unresolved"}`}>
      {resolved ? <Check size={11} /> : <span>—</span>}
      {label}
    </span>
  );
}

function Summary() {
  return (
    <div
      className="ledger-scroll"
      tabIndex={0}
      role="region"
      aria-label="v0.1.7 combined benchmark summary"
    >
      <table className="ledger v017-table">
        <caption className="sr-only">
          v0.1.7 Anchor and external harness results across SWE Lite, SWE Pro,
          and Terminal on the selected ten-task sets.
        </caption>
        <thead>
          <tr>
            <th scope="col">Bench</th>
            <th scope="col">Model</th>
            <th scope="col">External</th>
            <th className="anchor-col" scope="col">Anchor full credit</th>
            <th scope="col">External full credit</th>
            <th scope="col">Mean reward A / E</th>
            <th scope="col">Prompt tokens A / E</th>
            <th scope="col">Cost A</th>
            <th scope="col">p95 A / E</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((round) => (
            <tr key={`${round.bench}-${round.model}`}>
              <th scope="row">{round.benchLabel}</th>
              <td>{round.modelLabel}</td>
              <td>{round.harness}</td>
              <td className="anchor-col">
                {round.anchor.full}/{round.anchor.scored}
              </td>
              <td>
                {round.external.full}/{round.external.scored}
              </td>
              <td>
                {percent(round.anchor.mean)} / {percent(round.external.mean)}
              </td>
              <td>
                {number(round.anchor.prompt)} / {number(round.external.prompt)}
              </td>
              <td>{money(round.anchor.usd)}</td>
              <td>
                {number(Math.round(round.anchor.p95 / 1000))}s /{" "}
                {number(Math.round(round.external.p95 / 1000))}s
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaskLedger() {
  return (
    <div
      className="ledger-scroll"
      tabIndex={0}
      role="region"
      aria-label="SWE Lite DeepSeek v0.1.7 per-task ledger"
    >
      <table className="ledger v017-table">
        <caption className="sr-only">
          SWE Lite, DeepSeek V4.1 Flash: Anchor and SWE-agent per-task results.
          Anchor had one failed task; failed tasks are excluded from its
          full-credit denominator.
        </caption>
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th className="anchor-col" scope="col">Anchor</th>
            <th scope="col">SWE-agent</th>
            <th scope="col">Anchor time</th>
            <th scope="col">External time</th>
            <th scope="col">Anchor tokens</th>
            <th scope="col">External tokens</th>
          </tr>
        </thead>
        <tbody>
          {sweLiteDeepSeek.tasks.map((task) => (
            <tr key={task.id}>
              <th scope="row">{task.id}</th>
              <td className="anchor-col">
                <Outcome reward={task.anchor.reward} status={task.anchor.status} />
                {task.anchor.falseFinish ? <small> false finish</small> : null}
              </td>
              <td>
                <Outcome
                  reward={task.external.reward}
                  status={task.external.status}
                />
              </td>
              <td>{number(Math.round(task.anchor.wallMs / 1000))}s</td>
              <td>
                {task.external.wallMs == null
                  ? "—"
                  : `${number(Math.round(task.external.wallMs / 1000))}s`}
              </td>
              <td>{number(task.anchor.tokens)}</td>
              <td>{number(task.external.tokens)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">TOTAL / 10 TASKS</th>
            <td className="anchor-col">7/9 scored</td>
            <td>0/10</td>
            <td>{number(Math.round(rounds[0].anchor.p50 / 1000))}s p50</td>
            <td>{number(Math.round(rounds[0].external.p50 / 1000))}s p50</td>
            <td>{number(rounds[0].anchor.prompt)}</td>
            <td>{number(rounds[0].external.prompt)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Benchmarks() {
  return (
    <PageShell page="benchmarks">
      <section className="container bench-hero">
        <div className="bench-hero-copy">
          <span className="eyebrow">
            <span className="cross">+</span> BENCHMARKS / V0.1.7
          </span>
          <h1>
            Both arms.
            <br />
            <span>The receipts.</span>
          </h1>
          <p>
            Anchor against SWE-agent and Terminus-2.
            <br />
            Three suites. Two models. The complete v0.1.7 record.
          </p>
          <div className="round-tag">
            <span className="status-dot" /> COMPLETE ROUND{" "}
            <span>MEASURED 2FBC92B</span>
          </div>
          <a className="text-link" href="#results">
            Every result, every limit <ArrowRight size={15} />
          </a>
        </div>
        <div className="benchmark-dashboard">
          <div className="dashboard-title">
            <FlaskConical size={14} />
            <span>ANCHOR VS EXTERNAL / V0.1.7</span>
            <span className="dashboard-status">SELECTED SETS</span>
          </div>
          <div className="v017-summary">
            {[
              ["SWE LITE", "11/17", "Anchor vs 0/20 external"],
              ["SWE PRO", "15/20", "Anchor vs 9/20 external"],
              ["TERMINAL", "8/20", "Anchor vs 11/20 external"],
            ].map(([label, value, detail]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{detail}</small>
              </div>
            ))}
          </div>
          <div className="dashboard-bottom">
            <ShieldCheck size={12} /> Same selected tasks. Different harnesses.
          </div>
        </div>
      </section>

      <div className="container benchmark-disclosure">
        <span>READ THE FINE PRINT</span>
        <p>
          This is the complete v0.1.7 combined round. Anchor’s full-credit
          denominator excludes failed tasks; external counts all ten. The two
          arms use different harnesses, task handling, and budgets. These are
          selected samples, not a general performance guarantee. v0.1.8 has no
          recorded benchmark result.
        </p>
      </div>

      <section className="bench-results-section" id="results">
        <div className="container">
          <div className="section-heading">
            <div>
              <span className="eyebrow">
                <span className="cross">+</span> 01 / THE COMPLETE RECORD
              </span>
              <h2>
                No aggregate
                <br />
                without the details.
              </h2>
            </div>
            <a className="doc-inline-link" href={`${source}/summary.md`}>
              View source data <ArrowUpRight size={13} />
            </a>
          </div>
          <Summary />
          <div className="ledger-footnote">
            <span>
              <i /> Full credit is one task.
            </span>
            <p>
              External SWE-agent did not report cache or cost; those values are
              shown as —. Anchor costs are provider-reported. p95 is wall time,
              including task setup and verification where available.
            </p>
          </div>
        </div>
      </section>

      <section className="container bench-detail-section" id="detail">
        <div className="section-heading">
          <div>
            <span className="eyebrow">
              <span className="cross">+</span> 02 / ONE SUITE IN DETAIL
            </span>
            <h2>
              SWE Lite,
              <br />
              task by task.
            </h2>
          </div>
          <p>
            The same ten tasks, the same model. The detailed ledger shows why a
            single aggregate is never the whole story.
          </p>
        </div>
        <TaskLedger />
        <div className="ledger-footnote">
          <span>
            <i /> An empty cell is not a pass.
          </span>
          <p>
            One Anchor task failed before grading and is excluded from the 7/9
            denominator. All ten SWE-agent tasks were scored; none received
            full credit. Times are wall time, not a claim about model latency.
          </p>
        </div>
      </section>

      <section className="container benchmark-takeaways">
        <div>
          <span className="eyebrow">
            <span className="cross">+</span> 03 / THE HONEST READ
          </span>
          <h2>
            A lead here.
            <br />
            A trade-off there.
          </h2>
        </div>
        <div className="takeaway-list">
          <div>
            <span>01</span>
            <div>
              <h3>Anchor leads both SWE suites.</h3>
              <p>
                SWE Lite: 7/9 and 4/8 for Anchor vs 0/10 for SWE-agent. SWE Pro:
                10/10 and 5/10 vs 6/10 and 3/10. Full-credit denominators differ;
                failed Anchor tasks are not counted as passes.
              </p>
            </div>
          </div>
          <div>
            <span>02</span>
            <div>
              <h3>Terminus-2 wins Terminal.</h3>
              <p>
                The external arm took 8/10 and 3/10 against Anchor’s 7/10 and
                1/10. The Qwen Terminal result is the largest gap and the clearest
                next investigation, not a general harness verdict.
              </p>
            </div>
          </div>
          <div>
            <span>03</span>
            <div>
              <h3>Qwen is not one number.</h3>
              <p>
                Qwen’s SWE Pro result is 5/10 with Anchor and 3/10 external;
                Terminal is 1/10 and 3/10. The spread is a warning against
                ranking harnesses from one benchmark.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="benchmark-method">
        <div className="container method-grid">
          <div>
            <span className="eyebrow">
              <span className="cross">+</span> 04 / REPRODUCIBLE, NOT MYSTERIOUS
            </span>
            <h2>
              Open the hood.
              <br />
              Check our work.
            </h2>
            <p>
              The complete round and both arms are in the repository. The
              measured source is <code>2fbc92b</code>; the v0.1.7 tag points to
              <code> 08472b1</code>. Keep that distinction visible.
            </p>
            <div className="artifact-links">
              <a href={`${source}/anchor/summary.md`}>
                Anchor summary <ArrowUpRight size={13} />
              </a>
              <a href={`${source}/external/summary.md`}>
                External summary <ArrowUpRight size={13} />
              </a>
              <a href={`${source}/manifest.json`}>
                manifest.json <ArrowUpRight size={13} />
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
                "The task sets",
                "SWE Lite and SWE Pro use the selected ten-task sets; Terminal uses its selected ten-task set. Both arms run against the same task set, but the harness and its sandbox lifecycle differ.",
              ],
              [
                "models",
                "The models",
                "DeepSeek V4.1 Flash and Qwen3 Coder Next ran with reasoning effort high for Anchor. The external models were served through the same OpenRouter endpoint where reported.",
              ],
              [
                "accounting",
                "The accounting caveat",
                "External SWE-agent did not report cache or cost, so those values are unknown rather than zero. Anchor costs are provider-reported. p95 is wall time, not model-only latency.",
              ],
              [
                "limits",
                "What this round cannot tell you",
                "Ten tasks per suite, two models, one harness per arm, and differing full-credit denominators. This is a selected sample, not a statistical claim or a ranking across all workloads. v0.1.8 has no recorded result.",
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
            <span className="cross">+</span> 05 / RUN YOUR OWN ROUND
          </span>
          <h2>
            Don’t take the chart
            <br />
            at face value.
          </h2>
          <p>
            Use the pinned benchmark ref, a model, and a budget. The workflow
            records the measured SHA; do not move a tag to make an old result
            look current.
          </p>
          <a className="doc-inline-link" href={`${repo}/tree/main/evals`}>
            Eval runner and task data <ArrowUpRight size={13} />
          </a>
        </div>
        <CodeBlock
          code={`# After eval setup; Docker must be running and on PATH.
npm run eval --prefix evals -- \\
  --tasks benchmarks/swe-bench/data/swebench-lite-10.jsonl \\
  --provider docker --model deepseek/deepseek-v4.1-flash-1017 \\
  --max-steps 300 --max-tokens 50000000

# External arm: Harbor workflow, SWE-agent for SWE, Terminus-2 for Terminal.
# See .github/workflows/external-bench.yml.`}
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
