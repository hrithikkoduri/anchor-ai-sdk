#!/usr/bin/env bash
# Run one benchmark/model/variant shard. Each task is its own eval process so a
# single bad task cannot lose the shard's other results.
#
# Used by .github/workflows/bench.yml and runnable locally on a Docker host.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"

BENCH="${BENCH:-swe-lite}"
MODEL="${MODEL:-openai/gpt-5.3-codex}"
VARIANT="${VARIANT:-baseline}"
REASONING="${REASONING:-high}"
SHARD="${SHARD:-0}"
SHARDS="${SHARDS:-1}"
MAX_STEPS="${MAX_STEPS:-50}"
MAX_USD="${MAX_USD:-8}"
TASKS="${TASKS:-}"
OUT_ROOT="${OUT_ROOT:-.bench-runs}"

case "$BENCH" in
  swe-lite)
    TASKS_FILE="benchmarks/swe-bench/data/swebench-lite-10-local.jsonl"
    DEFAULT_TIME_BUDGET=900
    ;;
  swe-pro)
    TASKS_FILE="benchmarks/swe-bench-pro/data/tasks.jsonl"
    DEFAULT_TIME_BUDGET=3000
    ;;
  terminal-bench)
    TASKS_FILE="benchmarks/terminal-bench/data/tasks.jsonl"
    # Terminal-Bench task.toml carries per-task budgets up to 3600s; leave it
    # to the task unless the caller explicitly overrides it.
    DEFAULT_TIME_BUDGET=""
    ;;
  *)
    echo "unknown BENCH=$BENCH (swe-lite, swe-pro, terminal-bench)" >&2
    exit 2
    ;;
esac

TIME_BUDGET="${TIME_BUDGET:-$DEFAULT_TIME_BUDGET}"
MODEL_SLUG="$(printf '%s' "$MODEL" | tr '/:@' '---')"
OUT_DIR="${OUT_ROOT}/${BENCH}/${MODEL_SLUG}/${VARIANT}/shard-${SHARD}"
mkdir -p "$OUT_DIR"

mapfile -t IDS < <(
  node -e '
    const fs = require("fs");
    const [file, shard, shards] = process.argv.slice(1);
    const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    rows.forEach((row, index) => {
      if (index % Number(shards) === Number(shard)) console.log(row.id ?? row.instance_id);
    });
  ' "$TASKS_FILE" "$SHARD" "$SHARDS"
)

if [ "${#IDS[@]}" -eq 0 ]; then
  echo "no tasks selected for $BENCH shard $SHARD/$SHARDS" >&2
  exit 1
fi

echo "bench=$BENCH model=$MODEL variant=$VARIANT shard=$SHARD/$SHARDS tasks=${#IDS[@]}"
for ID in "${IDS[@]}"; do
  if [ -n "$TASKS" ] && ! printf ',%s,' "$TASKS" | grep -q ",$ID,"; then
    continue
  fi
  echo "=== $ID ==="
  EXTRA=()
  if [ -n "$TIME_BUDGET" ]; then
    EXTRA+=(--time-budget "$TIME_BUDGET")
  fi
  npx tsx src/main.ts \
    --tasks "$TASKS_FILE" \
    --task "$ID" \
    --bench "$BENCH" \
    --provider docker \
    --arm anchor \
    --llm openrouter \
    --model "$MODEL" \
    --variant "$VARIANT" \
    --reasoning "$REASONING" \
    --max-steps "$MAX_STEPS" \
    --max-usd "$MAX_USD" \
    "${EXTRA[@]}" \
    --out "$OUT_DIR/$ID" 2>&1 | tail -12
  status=${PIPESTATUS[0]}
  if [ "$status" -ne 0 ]; then
    echo "$status" > "$OUT_DIR/$ID/.exit-code"
  fi
  # Task images are large and each task is disposable; keep the runner under
  # the 14 GB Actions disk ceiling.
  docker system prune -af --volumes >/dev/null 2>&1 || true
done

# A shard that produced no result at all is an infrastructure failure, not a
# benchmark score. Individual task failures stay in the artifacts.
count="$(find "$OUT_DIR" -name results.jsonl -type f | wc -l | tr -d ' ')"
if [ "$count" -eq 0 ]; then
  echo "no results produced in $OUT_DIR" >&2
  exit 1
fi
echo "shard complete: $count task result file(s) in $OUT_DIR"
