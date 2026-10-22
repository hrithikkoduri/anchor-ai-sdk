# Anchor evals — v0.1.7 (2fbc92b)

Current main measured as package version 0.1.7. The Git tag `v0.1.7` points to older commit `08472b1` and predates the bench workflow.

## Anchor

# Anchor benchmark results

Generated: 2026-10-22T21:30:16.662Z

| Bench | Model | Variant | Tasks | Full credit | Mean reward | False finish | Timeout | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 7/9 (77.8%) | 0.778 | 2 | 1 | 7.58M | 271k | 7.15M | 94.4% | $0.30 | 5m | 17m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | 10 | 4/8 (50.0%) | 0.500 | 3 | 0 | 28.81M | 141k | 28.07M | 97.4% | $2.17 | 6m | 13m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 10/10 (100.0%) | 1.000 | 0 | 0 | 20.84M | 773k | 19.85M | 95.3% | $0.74 | 11m | 49m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | 10 | 5/10 (50.0%) | 0.500 | 1 | 0 | 35.15M | 147k | 34.32M | 97.7% | $2.62 | 7m | 19m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 7/10 (70.0%) | 0.700 | 0 | 0 | 7.38M | 397k | 6.67M | 90.4% | $0.45 | 8m | 17m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | 10 | 1/10 (10.0%) | 0.100 | 5 | 0 | 23.55M | 289k | 22.84M | 97.0% | $1.92 | 10m | 19m |



## External

# External harness results

Generated: 2026-10-22T21:44:33.958Z

| Bench | Model | Harness | Tasks | Full credit | Mean reward | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | swe-agent | 10 | 0/10 (0.0%) | 0.000 | 29.68M | 6k | — | — | — | 12m | 31m |
| swe-lite | `qwen/qwen3-coder-next` | swe-agent | 10 | 0/10 (0.0%) | 0.000 | 38.18M | 86k | — | — | $0.00 | 3m | 31m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | swe-agent | 10 | 6/10 (60.0%) | 0.600 | 25.73M | 8k | — | — | — | 21m | 101m |
| swe-pro | `qwen/qwen3-coder-next` | swe-agent | 10 | 3/10 (30.0%) | 0.300 | 89.84M | 64k | — | — | — | 17m | 60m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | terminus-2 | 10 | 8/10 (80.0%) | 0.800 | 3.91M | 408k | 2.80M | 71.6% | $0.58 | 6m | 20m |
| terminal-bench | `qwen/qwen3-coder-next` | terminus-2 | 10 | 3/10 (30.0%) | 0.300 | 11.91M | 185k | 11.41M | 95.8% | $1.01 | 16m | 38m |

