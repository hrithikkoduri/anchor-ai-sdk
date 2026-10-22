#!/usr/bin/env bash
# Run an external Harbor agent (default: Terminus-2) on one shard of the same
# tasks Anchor sees. This is the outside-world harness comparison.
set -uo pipefail

cd "$(dirname "$0")/.."

BENCH="${BENCH:-swe-lite}"
MODEL="${MODEL:-deepseek/deepseek-v4.1-flash-1017}"
SHARD="${SHARD:-0}"
SHARDS="${SHARDS:-1}"
AGENT="${AGENT:-terminus-2}"
OUT_ROOT="${OUT_ROOT:-external-runs}"
TASKS="${TASKS:-}"

case "$BENCH" in
  swe-lite)
    TASKS_DIR="$(pwd)/benchmarks/swe-bench-lite/data/tasks"
    TASKS_FILE="benchmarks/swe-bench-lite/data/tasks.jsonl"
    ;;
  swe-pro)
    TASKS_DIR="$(pwd)/benchmarks/swe-bench-pro/data/tasks"
    TASKS_FILE="benchmarks/swe-bench-pro/data/tasks.jsonl"
    ;;
  terminal-bench)
    TASKS_DIR="$(pwd)/benchmarks/terminal-bench/data/tasks"
    TASKS_FILE="benchmarks/terminal-bench/data/tasks.jsonl"
    ;;
  *)
    echo "unknown BENCH=$BENCH" >&2
    exit 2
    ;;
esac

MODEL_SLUG="$(printf '%s' "$MODEL" | tr '/:@' '---')"
OUT_DIR="${OUT_ROOT}/${BENCH}/${MODEL_SLUG}/external/shard-${SHARD}"
mkdir -p "$OUT_DIR"
cat > "$OUT_DIR/meta.json" <<EOF
{"bench":"$BENCH","model":"$MODEL","variant":"external","agent":"$AGENT","shard":$SHARD,"shards":$SHARDS}
EOF

mapfile -t IDS < <(
  node -e '
    const fs = require("fs");
    const [file, shard, shards] = process.argv.slice(1);
    const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    rows.forEach((row, index) => {
      if (index % Number(shards) === Number(shard)) console.log(row.id);
    });
  ' "$TASKS_FILE" "$SHARD" "$SHARDS"
)

if [ "${#IDS[@]}" -eq 0 ]; then
  echo "no external tasks selected" >&2
  exit 1
fi

if [ -n "$TASKS" ]; then
  FILTERED=()
  for ID in "${IDS[@]}"; do
    if printf ',%s,' "$TASKS" | grep -q ",$ID,"; then FILTERED+=("$ID"); fi
  done
  IDS=("${FILTERED[@]}")
fi
if [ "${#IDS[@]}" -eq 0 ]; then
  echo "no external tasks matched the filter" >&2
  exit 1
fi

MODEL_REF="$MODEL"
case "$MODEL_REF" in
  openrouter/*) ;;
  *) MODEL_REF="openrouter/$MODEL" ;;
esac

ARGS=(
  run
  -p "$TASKS_DIR"
  -e docker
  -n 1
  -a "$AGENT"
  -m "$MODEL_REF"
  -o "$OUT_DIR"
  --job-name "$BENCH-external-${MODEL_SLUG}-shard-${SHARD}"
  --allow-agent-host openrouter.ai
  --allow-agent-host api.openrouter.ai
)
for ID in "${IDS[@]}"; do
  ARGS+=(-i "$ID")
done

echo "external bench=$BENCH model=$MODEL agent=$AGENT shard=$SHARD/$SHARDS tasks=${#IDS[@]}"
echo "tasks dir: $TASKS_DIR"
find "$TASKS_DIR" -maxdepth 2 -name task.toml | head -3
"${PYTHON_BIN:-python3}" - "$TASKS_DIR" <<'PYDEBUG'
import pathlib, sys
from harbor.models.task.task import Task
root = pathlib.Path(sys.argv[1])
for d in sorted(root.iterdir())[:3]:
    try:
        print("valid task:", d.name, Task.is_valid_dir(d))
        from harbor.models.task.paths import TaskPaths
        from harbor.models.task.config import TaskConfig
        paths = TaskPaths(d)
        config = TaskConfig.model_validate_toml(paths.config_path.read_text())
        Task._validate_input_paths(config, paths)
        Task._validate_tests(config, paths)
        print("  detail ok")
    except Exception as e:
        print("invalid task:", d.name, type(e).__name__, e)
PYDEBUG
PYTHON_BIN="${PYTHON_BIN:-python3}"
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$LLM_API_KEY}" "$PYTHON_BIN" -m harbor.cli.main "${ARGS[@]}"

count="$(find "$OUT_DIR" -name result.json -type f | wc -l | tr -d ' ')"
if [ "$count" -eq 0 ]; then
  echo "no Harbor result.json produced in $OUT_DIR" >&2
  exit 1
fi
echo "external shard complete: $count result file(s) in $OUT_DIR"
