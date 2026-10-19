#!/usr/bin/env bash
# The baseline arm: mini-swe-agent — its own harness, its own Docker
# environments — on the same instances and the same model as the sailor arm.
#
#   evals/scripts/run-mini-baseline.sh [filter-regex]
#
# Default filter = the instance ids in benchmarks/swe-bench/data/swebench-lite-10.jsonl. Needs
# LLM_API_KEY in the repo .env (passed through as OPENROUTER_API_KEY).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$root/.." && pwd)"

default_filter="$(node -e '
  const fs = require("fs");
  const ids = fs.readFileSync(process.argv[1], "utf8").trim().split("\n")
    .map((line) => JSON.parse(line).instance_id);
  console.log(ids.join("|"));
' "$root/benchmarks/swe-bench/data/swebench-lite-10.jsonl")"
filter="${1:-$default_filter}"

set -a; . "$repo/.env"; set +a
export OPENROUTER_API_KEY="$LLM_API_KEY"
export MSWEA_GLOBAL_COST_LIMIT="${MINI_COST_LIMIT:-2}"
# Docker Desktop's bin dir (creds helper) + an empty creds config (public
# pulls must not need the keychain helper) + amd64 platform (the eval images
# are amd64-only; without this the pull 404s on arm64).
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
export DOCKER_CONFIG="$root/.eval-runs/mini/docker-config"
export DOCKER_DEFAULT_PLATFORM=linux/amd64
mkdir -p "$DOCKER_CONFIG"
printf '{}' >"$DOCKER_CONFIG/config.json"

model="${MINI_MODEL:-openrouter/deepseek/deepseek-v4.1-flash}"
echo "mini baseline · $model · filter: $filter"

"$root/.venv-mini/bin/mini-extra" swebench \
  -m "$model" \
  --subset lite \
  --split test \
  --filter "$filter" \
  --workers 1 \
  -o "$root/.eval-runs/mini" \
  -c swebench.yaml \
  -c environment.pull_timeout=900
