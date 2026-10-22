# Anchor benchmark results

Generated: 2026-10-22T21:18:41.532Z

| Bench | Model | Variant | Tasks | Full credit | Mean reward | False finish | Timeout | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `qwen/qwen3-coder-next` | baseline | 10 | 4/8 (50.0%) | 0.500 | 3 | 0 | 28.81M | 141k | 28.07M | 97.4% | $2.17 | 6m | 13m |

## Per task

| Bench | Model | Variant | Task | Reward | Status | Steps | Prompt tok | Completion tok | Cached tok | Cost | Wall |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| swe-lite | `qwen/qwen3-coder-next` | baseline | `django__django-10914` | — | failed | 108 | 2.67M | 15k | 2.60M | $0.20 | 5m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `matplotlib__matplotlib-18869` | 0.00 | completed (false finish) | 148 | 3.60M | 19k | 3.51M | $0.27 | 8m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `mwaskom__seaborn-2848` | 0.00 | completed (false finish) | 141 | 5.26M | 15k | 5.15M | $0.39 | 13m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pallets__flask-4045` | — | failed | 164 | 6.04M | 18k | 5.93M | $0.44 | 8m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `psf__requests-1963` | 1.00 | completed | 54 | 1.06M | 11k | 1.01M | $0.09 | 6m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pydata__xarray-3364` | 0.00 | completed | 22 | 332k | 1k | 302k | $0.03 | 2m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pylint-dev__pylint-5859` | 1.00 | completed | 84 | 2.04M | 12k | 1.97M | $0.16 | 5m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pytest-dev__pytest-11143` | 1.00 | completed | 88 | 1.75M | 11k | 1.69M | $0.13 | 5m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sphinx-doc__sphinx-10325` | 1.00 | completed | 116 | 4.87M | 32k | 4.76M | $0.37 | 11m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sympy__sympy-11400` | 0.00 | completed (false finish) | 59 | 1.20M | 7k | 1.15M | $0.09 | 3m |

