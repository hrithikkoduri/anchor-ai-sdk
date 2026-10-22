# External harness results

Generated: 2026-10-22T17:57:19.349Z

| Bench | Model | Harness | Tasks | Full credit | Mean reward | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | swe-agent | 1 | 0/1 (0.0%) | 0.000 | 2.34M | 1k | 0k | 0.0% | — | 12m | 12m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | swe-agent | 1 | 1/1 (100.0%) | 1.000 | 15.02M | 1k | 0k | 0.0% | — | 70m | 70m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | terminus-2 | 1 | 1/1 (100.0%) | 1.000 | 436k | 98k | 284k | 65.2% | $0.10 | 10m | 10m |

## Per task

| Bench | Model | Task | Reward | Status |
|---|---|---|---:|---|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/django__django-10914` | 0.00 | completed |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 1.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/chess-best-move` | 1.00 | completed |

