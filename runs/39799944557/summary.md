# External harness results

Generated: 2026-10-22T15:14:52.910Z

| Bench | Model | Harness | Tasks | Full credit | Mean reward | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | swe-agent | 1 | 0/1 (0.0%) | 0.000 | 0k | 0k | 0k | — | $0.00 | 16m | 16m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | swe-agent | 1 | 0/1 (0.0%) | 0.000 | 0k | 0k | 0k | — | $0.00 | 2m | 2m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | terminus-2 | 1 | 1/1 (100.0%) | 1.000 | 389k | 131k | 230k | 59.1% | $0.12 | 18m | 18m |

## Per task

| Bench | Model | Task | Reward | Status |
|---|---|---|---:|---|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/psf__requests-1963` | 0.00 | failed: Agent execution timed out after 900.0 seconds |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 0.00 | failed: Command failed (exit 1): set -euo pipefail
set +u
. /etc/profile.d/testbed-conda.sh || true
set -u
mkdir -p /logs/agent
 |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/adaptive-rejection-sampler` | 1.00 | failed: Agent execution timed out after 900.0 seconds |

