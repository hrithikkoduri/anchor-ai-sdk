# Anchor benchmark results

Generated: 2026-10-22T09:07:09.920Z

| Bench | Model | Variant | Tasks | Full credit | Mean reward | False finish | Timeout | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 7/10 (70.0%) | 0.750 | 2 | 1 | 8.33M | 263k | 0k | 0.0% | $0.27 | 6m | 17m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | 10 | 3/10 (30.0%) | 0.300 | 0 | 0 | 9.42M | 62k | 0k | 0.0% | $0.74 | 3m | 7m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 8/10 (80.0%) | 0.800 | 0 | 0 | 12.57M | 860k | 0k | 0.0% | $0.58 | 15m | 24m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | 10 | 4/10 (40.0%) | 0.400 | 1 | 0 | 11.31M | 72k | 0k | 0.0% | $0.87 | 5m | 6m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 4/10 (40.0%) | 0.400 | 0 | 1 | 6.19M | 376k | 0k | 0.0% | $0.26 | 10m | 39m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | 10 | 1/10 (10.0%) | 0.100 | 2 | 1 | 5.49M | 105k | 0k | 0.0% | $0.48 | 3m | 21m |

## Per task

| Bench | Model | Variant | Task | Reward | Status | Steps | Prompt tok | Completion tok | Cached tok | Cost | Wall |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `django__django-10914` | 0.00 | completed | 50 | 1.38M | 63k | 0k | $0.05 | 15m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `matplotlib__matplotlib-18869` | 1.00 | completed | 27 | 384k | 14k | 0k | $0.01 | 4m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `mwaskom__seaborn-2848` | 1.00 | timeout (timeout) | 47 | 1.27M | 28k | 0k | $0.03 | 17m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pallets__flask-4045` | 0.50 | completed (false finish) | 45 | 788k | 18k | 0k | $0.02 | 4m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `psf__requests-1963` | 1.00 | completed | 37 | 702k | 21k | 0k | $0.02 | 5m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pydata__xarray-3364` | 1.00 | completed | 42 | 981k | 31k | 0k | $0.05 | 9m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pylint-dev__pylint-5859` | 1.00 | completed | 28 | 312k | 8k | 0k | $0.01 | 4m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pytest-dev__pytest-11143` | 1.00 | completed | 41 | 713k | 35k | 0k | $0.03 | 10m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `sphinx-doc__sphinx-10325` | 1.00 | completed | 34 | 723k | 21k | 0k | $0.02 | 6m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `sympy__sympy-11400` | 0.00 | completed (false finish) | 49 | 1.08M | 23k | 0k | $0.04 | 5m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `django__django-10914` | 0.00 | completed | 50 | 811k | 4k | 0k | $0.06 | 2m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `matplotlib__matplotlib-18869` | 0.00 | completed | 50 | 588k | 5k | 0k | $0.05 | 3m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `mwaskom__seaborn-2848` | 0.00 | completed | 50 | 1.24M | 5k | 0k | $0.10 | 3m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pallets__flask-4045` | 0.00 | completed | 50 | 851k | 4k | 0k | $0.06 | 3m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `psf__requests-1963` | 1.00 | completed | 50 | 1.10M | 14k | 0k | $0.09 | 7m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pydata__xarray-3364` | 0.00 | completed | 50 | 1.20M | 6k | 0k | $0.09 | 3m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pylint-dev__pylint-5859` | 1.00 | completed | 50 | 938k | 9k | 0k | $0.08 | 4m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pytest-dev__pytest-11143` | 1.00 | completed | 50 | 827k | 9k | 0k | $0.07 | 5m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sphinx-doc__sphinx-10325` | 0.00 | completed | 50 | 825k | 4k | 0k | $0.06 | 7m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sympy__sympy-11400` | 0.00 | completed | 50 | 1.04M | 4k | 0k | $0.08 | 2m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 1.00 | completed | 50 | 1.29M | 33k | 0k | $0.03 | 9m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 1.00 | completed | 47 | 1.42M | 81k | 0k | $0.06 | 10m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed | 50 | 1.00M | 134k | 0k | $0.08 | 17m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed | 29 | 487k | 22k | 0k | $0.02 | 5m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 1.00 | completed | 43 | 1.23M | 57k | 0k | $0.04 | 12m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 1.00 | completed | 50 | 1.50M | 180k | 0k | $0.11 | 24m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 1.00 | completed | 50 | 1.32M | 22k | 0k | $0.03 | 9m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 0.00 | completed | 50 | 1.73M | 153k | 0k | $0.09 | 18m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed | 37 | 1.10M | 72k | 0k | $0.06 | 16m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 0.00 | completed | 50 | 1.49M | 108k | 0k | $0.07 | 15m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 1.00 | completed | 50 | 1.17M | 6k | 0k | $0.09 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 0.00 | completed | 32 | 818k | 9k | 0k | $0.07 | 6m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed | 50 | 963k | 8k | 0k | $0.08 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed | 45 | 1.05M | 13k | 0k | $0.09 | 6m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 0.00 | failed (false finish) | 47 | 1.50M | 4k | 0k | $0.11 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 1.00 | completed | 35 | 676k | 6k | 0k | $0.05 | 6m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 0.00 | failed | 25 | 388k | 1k | 0k | $0.03 | 3m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 0.00 | completed | 50 | 1.85M | 7k | 0k | $0.14 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 0.00 | completed | 50 | 1.56M | 12k | 0k | $0.12 | 6m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 0.00 | completed | 50 | 1.33M | 6k | 0k | $0.10 | 4m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `adaptive-rejection-sampler` | 0.00 | completed | 6 | 22k | 32k | 0k | $0.02 | 7m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `chess-best-move` | 0.00 | completed | 50 | 1.52M | 72k | 0k | $0.06 | 10m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `bn-fit-modify` | 1.00 | completed | 30 | 359k | 25k | 0k | $0.02 | 8m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `circuit-fibsqrt` | 0.00 | completed | 4 | 22k | 32k | 0k | $0.02 | 9m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `break-filter-js-from-html` | 1.00 | completed | 15 | 85k | 11k | 0k | $0.01 | 2m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cobol-modernization` | 0.00 | completed | 50 | 950k | 58k | 0k | $0.04 | 13m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `build-cython-ext` | 1.00 | completed | 50 | 972k | 14k | 0k | $0.02 | 3m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `code-from-image` | 0.00 | completed | 50 | 1.59M | 72k | 0k | $0.06 | 15m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cancel-async-tasks` | 1.00 | timeout (timeout) | 6 | 17k | 43k | 0k | $0.01 | 15m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `compile-compcert` | 0.00 | completed | 50 | 647k | 16k | 0k | $0.01 | 39m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `adaptive-rejection-sampler` | 0.00 | timeout (timeout) | 26 | 541k | 41k | 0k | $0.07 | 15m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `chess-best-move` | 0.00 | completed (false finish) | 41 | 1.55M | 31k | 0k | $0.14 | 8m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `bn-fit-modify` | 0.00 | completed | 9 | 39k | 0k | 0k | $0.00 | 1m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `circuit-fibsqrt` | 0.00 | completed | 5 | 19k | 0k | 0k | $0.00 | 0m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `break-filter-js-from-html` | 0.00 | completed | 15 | 73k | 1k | 0k | $0.01 | 1m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cobol-modernization` | 0.00 | completed | 34 | 450k | 6k | 0k | $0.04 | 3m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `build-cython-ext` | 0.00 | completed | 20 | 220k | 1k | 0k | $0.02 | 2m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `code-from-image` | 1.00 | completed | 43 | 1.74M | 15k | 0k | $0.14 | 6m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cancel-async-tasks` | 0.00 | completed (false finish) | 43 | 324k | 5k | 0k | $0.03 | 3m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `compile-compcert` | 0.00 | completed | 50 | 531k | 3k | 0k | $0.04 | 21m |

