# @anchor/evals — the benchmark harness

Scores **Anchor as a harness**, benchmark by benchmark. This is not a product
feature and not part of the package: it is a repo-level app that imports
`anchor-ai-sdk` directly — no worker, no queue, no webhook, no database —
which makes it the framework's second consumer. The app has **zero product
imports** — its own config reader, the package, and nothing else.

## Layout

```
benchmarks/
  swe-bench/       SWE-bench Lite (larger sets on demand) vs mini-swe-agent.
                   Data, results, and the full how-to live in its README.
  terminal-bench/  planned — terminal-native tasks, per-task containers.
  program-bench/   planned.
  metr/            planned.
src/               the harness engine: the generic runner (tasks → sandbox →
                   arm → git diff — the future Anchor lift, deliberately one
                   isolated module), the config reader, the CLI, the arms.
scripts/           run/build tooling: fetch tasks, prepull/prewarm images,
                   grade with the official harness, watch-and-grade, report.
.eval-runs/        local, gitignored run artifacts (predictions, traces,
                   grading reports).
.venv / .venv-mini host venvs: the official grader, and the mini baseline.
```

`src/runner.ts` is benchmark-agnostic by design: a benchmark contributes a
task loader, an arm, and (usually) a grader — never a second runner. Pieces
move into `benchmarks/<name>/` when their seams are proven by a second
benchmark landing; data and results already live per-benchmark today.

## Configuration

Copy `.env.example` to `.env` and fill in `LLM_API_KEY` (and `E2B_API_KEY` for the E2B backend). `.env` is gitignored; the example contains no secrets.

## Benchmarks

| benchmark | status | docs |
| --- | --- | --- |
| **swe-bench** | Round 1 shipped (GLM 5.3) | [`benchmarks/swe-bench/README.md`](benchmarks/swe-bench/README.md) |
| **terminal-bench** | planned | [`benchmarks/terminal-bench/README.md`](benchmarks/terminal-bench/README.md) |
| **program-bench** | planned | [`benchmarks/program-bench/README.md`](benchmarks/program-bench/README.md) |
| **metr** | planned | [`benchmarks/metr/README.md`](benchmarks/metr/README.md) |

Results always live next to their benchmark: `benchmarks/<name>/results/`.
