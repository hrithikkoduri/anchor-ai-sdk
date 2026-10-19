# @anchor/evals — the harness benchmark

Scores **Anchor as a harness** on SWE-bench. This is not a product feature and
not part of the package: it is a repo-level app that imports `anchor-ai-sdk`
directly — no worker, no queue, no webhook, no database — which makes it the
framework's second consumer. The system under test is the framework's own
`codingAgent` plus benchmark context added here; the app has **zero product
imports** — its own config reader, the package, and nothing else.

## Layout

```
src/runner.ts       the generic runner: tasks → sandbox → arm → git diff (the
                    future Anchor lift; one isolated module, by design)
src/arms/anchor.ts  system under test #1: codingAgent + benchmark context
src/arms/mini-swe.ts  system under test #2: mini-swe-agent via its python
                    bindings, in the SAME container (the baseline)
src/tasks.ts        SWE-bench row → EvalTask, incl. the task's Docker image
                    (arms never see gold patches)
src/main.ts         CLI: predictions.jsonl + results.jsonl + run.json + traces/
scripts/            fetch-tasks · grade · prepull-images · run-mini-baseline
data/               the committed task subset (deterministic, one per repo)
```

## Setup (once)

```bash
# grader venv
/opt/homebrew/bin/python3.12 -m venv evals/.venv
evals/.venv/bin/pip install swebench

# baseline-arm venv (isolated: mini pulls its own litellm stack)
/opt/homebrew/bin/python3.12 -m venv evals/.venv-mini
evals/.venv-mini/bin/pip install mini-swe-agent
```

Docker Desktop must be installed and running. **The eval images are
amd64-only** — the scripts force `DOCKER_DEFAULT_PLATFORM=linux/amd64`, and
the platform runs them under emulation on Apple Silicon (slower, but exactly
the images the SWE-bench numbers come from). The scripts also point
`DOCKER_CONFIG` at an empty config so public pulls never ask for the macOS
keychain helper.

## Run it

```bash
# 1. fetch a subset (or use the committed data/swebench-lite-10.jsonl)
node evals/scripts/fetch-tasks.mjs --limit 10 --out evals/data/swebench-lite-10.jsonl

# 2. the real thing: the official task image (repo at /testbed, deps installed)
DOCKER_BIN=/Applications/Docker.app/Contents/Resources/bin/docker \
  npm run eval --prefix evals -- --tasks data/swebench-lite-10.jsonl \
  --provider docker --model z-ai/glm-5.3 --max-steps 60

# the baseline arm — same tasks, same model, same container:
DOCKER_BIN=/Applications/Docker.app/Contents/Resources/bin/docker \
  npm run eval --prefix evals -- --tasks data/swebench-lite-10.jsonl \
  --provider docker --model z-ai/glm-5.3 --arm mini

# 3. bigger sets: Verified (500) or the full benchmark (2294) — fetch on demand
node evals/scripts/fetch-tasks.mjs --dataset SWE-bench/SWE-bench_Verified \
  --limit 500 --out evals/data/swebench-verified.jsonl

# dev smoke stays cheap: same command with --provider local
```

Outputs land in `.eval-runs/<timestamp>/`: `predictions.jsonl` is the official
grader's input, `results.jsonl` keeps status/steps/usage/cost, `traces/` holds
every engine event per task.

## Grade

```bash
evals/scripts/grade.sh <predictions.jsonl> <run_id> [instance_ids...]
# e.g. evals/scripts/grade.sh .eval-runs/smoke/predictions.jsonl smoke1 psf__requests-1963
```

Runs the **official `swebench` harness** locally in Docker (it pulls its own
per-instance images and matches `instance_id`s) and writes
`<model>.<run_id>.json` under `.eval-runs/grading/<run_id>/`. Patch production
is fully decoupled from grading — Docker quirks can never corrupt a run.

## Baseline arm

The baseline runs through the **same runner** as anchor — same task images,
same container, same model, same patch extraction — so the only variable
between the two table rows is the agent design:

```bash
DOCKER_BIN=… npm run eval --prefix evals -- \
  --tasks data/swebench-lite-10.jsonl --provider docker \
  --model <model> --arm mini --image-tag mini-eval
```

mini is embedded via its python bindings (with its own `swebench.yaml`
templates) into prewarmed images (`scripts/prewarm-mini-images.mjs`), so no
setup cost lands inside the measured run.

`scripts/run-mini-baseline.sh` remains as an **optional cross-check**: it
drives mini's own CLI harness in its own Docker environments — a different
environment by construction, useful for sanity, not the report row.

## Watch the agents

Every anchor task writes a **full event trace** (thoughts, tool calls, results,
checkpoints) — `traces/<task>.jsonl` in the run directory. Every mini task
copies **its own trajectory** out of the container — `artifacts/mini-<task>.json`.
Both render with one viewer:

```bash
node evals/scripts/show-trace.mjs .eval-runs/<run>/traces/<task>.jsonl
node evals/scripts/show-trace.mjs .eval-runs/<run>/artifacts/mini-<task>.json
# add --full for untruncated text
```

## Protocol

- **One report run per arm**, on the same task set, same model, same task
  images, same grader. That run's result is the number — no tuned/untuned
  variants, no cherry-picking across attempts or runs.
- A patch is re-produced or re-graded **only when the tooling lost it** (e.g.
  a failed extraction destroyed a real diff) — that is a bug being repaired,
  not scoring policy.
- Retries are _not_ best-of-N, and best-of-N is not used here at all: no
  parallel racing, no second attempts for score. (Best-of-N is a deferred
  package feature — `fork()`.)
- **Timing caveat:** this batch ran both arms (plus setup jobs) on one
  machine under emulation. Resolve rate is the primary metric; wall-times are
  indicative, not clean-room (a strictly serial, quiet-machine run is the
  protocol for the Verified-scale numbers).

## Read the numbers with this caveat

DeepSeek V4.1 Flash has SWE-bench Lite memorized for popular instances: the
first smoke task (`psf__requests-1963`) returned the verbatim gold patch and
the hidden gold test, from the problem statement alone. Runs default to
less-memorized models (GLM 5.3; Claude Opus 5.5 for comparison), and the
report flags exact/near gold-patch matches. The A/B still measures the
harnesses head-to-head (same instances, same model), but absolute Lite scores
overstate real capability — the seeded-bug track (repos we control, post-cutoff
commits) is the contamination-free complement.
