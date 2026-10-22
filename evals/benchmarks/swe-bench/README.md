# swe-bench Lite

Scores **Anchor** on SWE-bench Lite. The benchmark supplies the task image,
the model, and the official test patch; the harness is the variable. This
benchmark's data and results live here; the shared runner lives in
[`../../src/runner.ts`](../../src/runner.ts).

## Layout

```
main.ts          CLI: predictions.jsonl + results.jsonl + run.json + traces/
tasks.ts         SWE-bench row → EvalTask, incl. the task's Docker image
                 (arms never see gold patches)
arms/anchor.ts   system under test: codingAgent + benchmark context
data/            the committed task subset (deterministic, one per repo)
results/         verdicts + the comparison table, per round
```

## Setup (once, with venvs at the evals root)

```bash
# grader venv
/opt/homebrew/bin/python3.12 -m venv evals/.venv
evals/.venv/bin/pip install swebench
```

Docker Desktop must be installed and running. **The eval images are
amd64-only**: the scripts force `DOCKER_DEFAULT_PLATFORM=linux/amd64`, and
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
  --provider docker --model deepseek/deepseek-v4.1-flash-1017 --reasoning high --max-steps 50

# 3. bigger sets: Verified (500) or the full benchmark (2294): fetch on demand
node scripts/fetch-tasks.mjs --dataset SWE-bench/SWE-bench_Verified \
  --limit 500 --out benchmarks/swe-bench/data/swebench-verified.jsonl

# dev smoke stays cheap: same command with --provider local
```

### Run the same tasks on E2B

E2B boots **templates**, not arbitrary Docker images, so each image-backed
task needs a template built from its SWE-bench image. Repo-clone tasks use the
default `E2B_TEMPLATE`.

```bash
# build one template (a few minutes; ~1 GB image)
E2B_API_KEY=... node scripts/build-e2b-templates.mjs \
  --tasks benchmarks/swe-bench/data/swebench-lite-10.jsonl \
  --task psf__requests-1963

# it prints E2B_TEMPLATE_MAP; use it for the run
E2B_API_KEY=... E2B_USER=root \
E2B_TEMPLATE_MAP='{"psf__requests-1963":"anchor-swebench-psf-requests-1963:latest"}' \
  npm run eval --prefix evals -- \
  --tasks benchmarks/swe-bench/data/swebench-lite-10.jsonl \
  --provider e2b --task psf__requests-1963 --model z-ai/glm-5.3 --max-steps 60
```

`E2B_TIMEOUT_MS` controls the sandbox lifetime (default 1 hour; Hobby caps there)
there). E2B's image tasks run as `root`, matching the SWE-bench images.
Unlike Docker, E2B is remote; `DOCKER_BIN` is irrelevant, and the grader
still runs locally in Docker exactly as before.

For a fast, E2B-native sanity check (not a replacement for the official
grader), apply the dataset's test patch and the prediction inside the task's
own E2B template and run the official FAIL_TO_PASS + PASS_TO_PASS ids:

```bash
E2B_API_KEY=... node scripts/verify-e2b-prediction.mjs \
  --prediction .eval-runs/<out>/predictions.jsonl \
  --instance pallets__flask-4045 \
  --template anchor-swebench-pallets-flask-4045:latest
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
`.eval-runs` (its title and prices are pinned per round; update both when a
new round starts).

## Results

- **Round 1: `z-ai/glm-5.3` (2026-10-18):** 7/10 vs 7/10 resolved, at
  **$0.60 vs ≈$1.99** and **5.28M vs ≈17.0M tokens**.
  [`results/comparison.md`](results/comparison.md) ·
  [`results/verdicts.jsonl`](results/verdicts.jsonl)
