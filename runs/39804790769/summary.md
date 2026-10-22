# External harness results

Generated: 2026-10-22T15:50:22.886Z

| Bench | Model | Harness | Tasks | Full credit | Mean reward | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | swe-agent | 1 | 0/1 (0.0%) | 0.000 | 0k | 0k | 0k | — | $0.00 | 17m | 17m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | swe-agent | 1 | 0/1 (0.0%) | 0.000 | 0k | 0k | 0k | — | $0.00 | 21m | 21m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | terminus-2 | 1 | 0/1 (0.0%) | 0.000 | 118k | 104k | 74k | 62.6% | $0.07 | 16m | 16m |

## Per task

| Bench | Model | Task | Reward | Status |
|---|---|---|---:|---|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/psf__requests-1963` | 0.00 | completed |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 0.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/adaptive-rejection-sampler` | 0.00 | failed: Agent execution timed out after 900.0 seconds |

