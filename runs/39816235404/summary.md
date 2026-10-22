# Anchor benchmark results

Generated: 2026-10-22T17:40:28.014Z

| Bench | Model | Variant | Tasks | Full credit | Mean reward | False finish | Timeout | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | 1 | 0/1 (0.0%) | 0.000 | 0 | 1 | 971k | 39k | 910k | 93.8% | $0.03 | 16m | 16m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | 1 | 1/1 (100.0%) | 1.000 | 0 | 1 | 6.86M | 309k | 6.43M | 93.7% | $0.30 | 53m | 53m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | 1 | 1/1 (100.0%) | 1.000 | 0 | 0 | 1.19M | 56k | 1.14M | 95.7% | $0.05 | 10m | 10m |

## Per task

| Bench | Model | Variant | Task | Reward | Status | Steps | Prompt tok | Completion tok | Cached tok | Cost | Wall |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `django__django-10914` | 0.00 | timeout (timeout) | 42 | 971k | 39k | 910k | $0.03 | 16m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 1.00 | timeout (timeout) | 106 | 6.86M | 309k | 6.43M | $0.30 | 53m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `chess-best-move` | 1.00 | completed | 49 | 1.19M | 56k | 1.14M | $0.05 | 10m |

