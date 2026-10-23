# External harness results

Generated: 2026-10-23T11:04:29.657Z

| Bench | Model | Harness | Tasks | Full credit | Mean reward | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | swe-agent | 1 | 1/1 (100.0%) | 1.000 | 1.26M | 2k | — | — | — | 10m | 10m |
| swe-lite | `qwen/qwen3-coder-next` | swe-agent | 1 | 1/1 (100.0%) | 1.000 | 27.55M | 9k | — | — | — | 31m | 31m |

## Per task

| Bench | Model | Task | Reward | Status |
|---|---|---|---:|---|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/psf__requests-1963` | 1.00 | completed |
| swe-lite | `qwen/qwen3-coder-next` | `swe-bench-lite/psf__requests-1963` | 1.00 | failed: Agent execution timed out after 1800.0 seconds |

