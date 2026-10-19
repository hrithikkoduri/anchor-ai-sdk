# swe-bench — Anchor vs mini-swe-agent

Scores **Anchor as a harness** on SWE-bench. Same task images, same model,
same runner, same patch extraction, same official grader — the only variable
is the harness. This benchmark's data and results live here; the shared
runner lives in [`../../src/runner.ts`](../../src/runner.ts).

## Layout

```
main.ts          CLI: predictions.jsonl + results.jsonl + run.json + traces/
tasks.ts         SWE-bench row → EvalTask, incl. the task's Docker image
                 (arms never see gold patches)
arms/anchor.ts   system under test #1: codingAgent + benchmark context
arms/mini-swe.ts system under test #2: mini-swe-agent via its python
                 bindings, in the SAME container (the baseline)
data/            the committed task subset (deterministic, one per repo)
results/         verdicts + the comparison table, per round
```

## Setup (once; venvs live at the evals root)

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

## Run it (from `evals/`)

```bash
# 1. fetch a subset (or use the committed data/swebench-lite-10.jsonl)
node scripts/fetch-tasks.mjs --limit 10 --out benchmarks/swe-bench/data/swebench-lite-10.jsonl

# 2. the real thing: the official task image (repo at /testbed, deps installed)
DOCKER_BIN=/Applications/Docker.app/Contents/Resources/bin/docker \
  npm run eval --prefix evals -- --tasks benchmarks/swe-bench/data/swebench-lite-10.jsonl \
  --provider docker --model z-ai/glm-5.3 --max-steps 60

# the baseline arm — same tasks, same model, same container:
DOCKER_BIN=/Applications/Docker.app/Contents/Resources/bin/docker \
  npm run eval --prefix evals -- --tasks benchmarks/swe-bench/data/swebench-lite-10.jsonl \
  --provider docker --model z-ai/glm-5.3 --arm mini

# 3. bigger sets: Verified (500) or the full benchmark (2294) — fetch on demand
node scripts/fetch-tasks.mjs --dataset SWE-bench/SWE-bench_Verified \
  --limit 500 --out benchmarks/swe-bench/data/swebench-verified.jsonl

# dev smoke stays cheap: same command with --provider local
```

Outputs land in `.eval-runs/<out>`: `predictions.jsonl` is the official
grader's input, `results.jsonl` keeps status/steps/usage/cost, `traces/`
holds every engine event per task.

## Grade it

```bash
evals/scripts/grade.sh <predictions.jsonl> <run_id> [instance_ids...]
```

Auto-prepulls the images, runs the official `swebench` harness in Docker (one
worker), and writes per-instance reports under `.eval-runs/grading/<run_id>/`.
`scripts/watch-and-grade.mjs` polls run dirs and grades completed tasks as
they land; `scripts/report.mjs` renders the comparison table from
`.eval-runs` (its title and prices are pinned per round — update both when a
new round starts).

## Results

- **Round 1 — `z-ai/glm-5.3` (2026-10-18):** 7/10 vs 7/10 resolved — at
  **$0.60 vs ≈$1.99** and **5.28M vs ≈17.0M tokens**.
  [`results/comparison.md`](results/comparison.md) ·
  [`results/verdicts.jsonl`](results/verdicts.jsonl)
