# @anchor/evals: the benchmark harness

Scores **Anchor as a harness**, benchmark by benchmark. This is not a product
feature and not part of the package: it is a repo-level app that imports
`anchor-ai-sdk` directly: no worker, no queue, no webhook, no database;
which makes it the framework's second consumer. The app has **zero product
imports**: its own config reader, the package, and nothing else.

## Layout

```
benchmarks/
  swe-bench/       SWE-bench Lite (larger sets on demand).
                   Data, results, and the full how-to live in its README.
  swe-bench-pro/   SWE-bench Pro V2, ten Harbor tasks, patch replay.
  terminal-bench/  Terminal-Bench 2.1, ten Harbor tasks, in-place verifier.
src/               the harness engine: the generic runner (tasks → sandbox →
                   arm → git diff, the future Anchor lift, deliberately one
                   isolated module), the config reader, the CLI, the arms.
scripts/           run/build tooling: fetch tasks, prepull/prewarm images,
                   grade with the official harness, watch-and-grade, report.
.eval-runs/        local, gitignored run artifacts (predictions, traces,
                   grading reports).
.venv            host venv for the official SWE-bench grader.
```

`src/runner.ts` is benchmark-agnostic by design: a benchmark contributes a
task loader, an arm, and (usually) a grader, never a second runner. Pieces
move into `benchmarks/<name>/` when their seams are proven by a second
benchmark landing; data and results already live per-benchmark today.

## Configuration

Copy `.env.example` to `.env` and fill in `LLM_API_KEY` (and `E2B_API_KEY` for the E2B backend). `.env` is gitignored; the example contains no secrets.

## Benchmarks

| benchmark | status | docs |
| --- | --- | --- |
| **swe-bench Lite** | Round 1 shipped (GLM 5.3); Docker + official test patches | [`benchmarks/swe-bench/README.md`](benchmarks/swe-bench/README.md) |
| **swe-bench Pro V2** | Ten Harbor tasks, patch replay | [`benchmarks/swe-bench-pro/README.md`](benchmarks/swe-bench-pro/README.md) |
| **terminal-bench 2.1** | Ten Harbor tasks, in-place verifier | [`benchmarks/terminal-bench/README.md`](benchmarks/terminal-bench/README.md) |

Results always live next to their benchmark: `benchmarks/<name>/results/`.

The swe-bench runner also accepts `--provider e2b` (template-backed remote
sandboxes); see the E2B section in its README.

## GitHub Actions

`.github/workflows/bench.yml` runs the whole matrix on `ubuntu-latest` with
Docker: three benchmarks × two models × two variants, sharded to stay under
the six-hour job limit. It needs one repository secret:

- `LLM_API_KEY` — an OpenRouter key.

The workflow writes raw results as artifacts and publishes:
- `latest/summary.md` and `latest/summary.json` on the `bench-results` branch;
- `dashboard/index.html` on the same branch (enable GitHub Pages from that
  branch to view it).

Trigger it from **Actions → bench → Run workflow**. `bench=all` runs the six
baseline + six treatment logical runs; pick one benchmark or one variant to
iterate cheaper.
