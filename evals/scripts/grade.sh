#!/usr/bin/env bash
# Grade a predictions file with the official SWE-bench harness, locally in Docker.
#
#   evals/scripts/grade.sh <predictions.jsonl> <run_id> [instance_ids...]
#
# Hard-won details (2026-10-18):
#   - swebench 5.x wants the CURRENT dataset (SWE-bench/SWE-bench_Lite) — the
#     legacy princeton-nlp path lacks per-row `image` fields and fails with
#     KeyError: 'image'.
#   - DOCKER_CONFIG points at an empty config: otherwise the docker SDK wants
#     docker-credential-osxkeychain on PATH even for public pulls.
#   - The eval images are amd64-ONLY. DOCKER_DEFAULT_PLATFORM does not help
#     the harness (that env var is Docker-CLI-only and the harness pulls via
#     the SDK), so we pre-pull with `--platform linux/amd64` ourselves — see
#     scripts/prepull-images.mjs. Containers then run under emulation on
#     Apple Silicon: slower, but exactly the images the SWE-bench numbers
#     come from.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
preds="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
run_id="$2"
shift 2

out="$root/.eval-runs/grading/$run_id"
mkdir -p "$out/docker-config"
printf '{}' >"$out/docker-config/config.json"
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

if [ "$#" -gt 0 ]; then
  node "$root/scripts/prepull-images.mjs" "$@"
else
  node "$root/scripts/prepull-images.mjs" --from-predictions "$preds"
fi

instance_args=()
if [ "$#" -gt 0 ]; then instance_args=(-i "$@"); fi

cd "$out"
DOCKER_CONFIG="$out/docker-config" "$root/.venv/bin/python" \
  -m swebench.harness.run_evaluation \
  -d SWE-bench/SWE-bench_Lite \
  -p "$preds" \
  -id "$run_id" \
  --max_workers 1 \
  --report_dir "$out" \
  ${instance_args[@]+"${instance_args[@]}"}
