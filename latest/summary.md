# Anchor benchmark results

Generated: 2026-10-22T07:35:55.050Z

| Bench | Model | Variant | Tasks | Full credit | Mean reward | False finish | Timeout | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 8/10 (80.0%) | 0.800 | 1 | 1 | 7.76M | 239k | 0k | 0.0% | $0.18 | 7m | 16m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | 10 | 2/9 (22.2%) | 0.222 | 0 | 0 | 7.35M | 51k | 0k | 0.0% | $0.57 | 3m | 5m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 8/10 (80.0%) | 0.800 | 0 | 0 | 12.22M | 677k | 0k | 0.0% | $0.27 | 11m | 22m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | 10 | 4/10 (40.0%) | 0.400 | 1 | 0 | 12.78M | 85k | 0k | 0.0% | $0.99 | 6m | 7m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 3/10 (30.0%) | 0.300 | 0 | 2 | 6.43M | 387k | 0k | 0.0% | $0.16 | 10m | 24m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | 10 | 4/10 (40.0%) | 0.400 | 1 | 0 | 9.42M | 163k | 0k | 0.0% | $0.80 | 7m | 22m |

## Per task

| Bench | Model | Variant | Task | Reward | Status | Steps | Prompt tok | Completion tok | Cached tok | Cost | Wall |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `django__django-10914` | 0.00 | completed | 50 | 1.16M | 36k | 0k | $0.01 | 12m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `matplotlib__matplotlib-18869` | 1.00 | completed | 28 | 386k | 13k | 0k | $0.01 | 3m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `mwaskom__seaborn-2848` | 1.00 | timeout (timeout) | 28 | 448k | 28k | 0k | $0.01 | 16m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pallets__flask-4045` | 1.00 | completed | 42 | 868k | 18k | 0k | $0.02 | 4m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `psf__requests-1963` | 1.00 | completed | 45 | 998k | 31k | 0k | $0.01 | 6m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pydata__xarray-3364` | 1.00 | completed | 50 | 1.50M | 28k | 0k | $0.06 | 13m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pylint-dev__pylint-5859` | 1.00 | completed | 17 | 192k | 7k | 0k | $0.01 | 3m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pytest-dev__pytest-11143` | 1.00 | completed | 39 | 698k | 23k | 0k | $0.01 | 7m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `sphinx-doc__sphinx-10325` | 1.00 | completed | 47 | 1.17M | 42k | 0k | $0.03 | 11m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `sympy__sympy-11400` | 0.00 | completed (false finish) | 30 | 344k | 13k | 0k | $0.01 | 2m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `django__django-10914` | — | failed | 50 | 852k | 5k | 0k | $0.07 | 3m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `matplotlib__matplotlib-18869` | 0.00 | completed | 50 | 611k | 6k | 0k | $0.05 | 4m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `mwaskom__seaborn-2848` | 0.00 | completed | 36 | 519k | 2k | 0k | $0.04 | 2m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pallets__flask-4045` | 0.00 | completed | 50 | 671k | 4k | 0k | $0.05 | 3m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `psf__requests-1963` | 1.00 | completed | 32 | 419k | 3k | 0k | $0.03 | 2m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pydata__xarray-3364` | 0.00 | completed | 50 | 995k | 9k | 0k | $0.08 | 5m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pylint-dev__pylint-5859` | 0.00 | completed | 50 | 812k | 8k | 0k | $0.07 | 4m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pytest-dev__pytest-11143` | 1.00 | completed | 50 | 759k | 5k | 0k | $0.06 | 3m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sphinx-doc__sphinx-10325` | 0.00 | completed | 50 | 751k | 4k | 0k | $0.06 | 3m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sympy__sympy-11400` | 0.00 | completed | 50 | 964k | 5k | 0k | $0.07 | 3m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 1.00 | completed | 50 | 1.07M | 22k | 0k | $0.03 | 11m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 1.00 | completed | 50 | 1.45M | 66k | 0k | $0.02 | 11m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed | 50 | 895k | 41k | 0k | $0.01 | 11m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed | 47 | 1.00M | 47k | 0k | $0.02 | 8m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 1.00 | completed | 42 | 1.02M | 35k | 0k | $0.03 | 18m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 0.00 | completed | 50 | 1.90M | 121k | 0k | $0.04 | 19m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 1.00 | completed | 50 | 1.31M | 38k | 0k | $0.02 | 9m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 1.00 | completed | 50 | 1.68M | 174k | 0k | $0.05 | 21m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed | 16 | 271k | 18k | 0k | $0.02 | 4m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 0.00 | completed | 50 | 1.61M | 115k | 0k | $0.04 | 22m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 0.00 | completed | 50 | 1.22M | 7k | 0k | $0.09 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 0.00 | completed | 50 | 1.98M | 5k | 0k | $0.15 | 6m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed | 50 | 1.44M | 17k | 0k | $0.12 | 7m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 0.00 | completed | 50 | 1.55M | 9k | 0k | $0.12 | 6m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 0.00 | completed (false finish) | 28 | 386k | 1k | 0k | $0.03 | 2m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 0.00 | completed | 50 | 1.56M | 10k | 0k | $0.12 | 7m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed | 50 | 1.01M | 11k | 0k | $0.08 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed | 43 | 706k | 12k | 0k | $0.06 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 0.00 | completed | 50 | 1.93M | 7k | 0k | $0.14 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 1.00 | completed | 50 | 993k | 5k | 0k | $0.08 | 7m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `adaptive-rejection-sampler` | 0.00 | completed | 5 | 21k | 32k | 0k | $0.01 | 5m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `chess-best-move` | 0.00 | completed | 50 | 1.99M | 66k | 0k | $0.03 | 10m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `bn-fit-modify` | 1.00 | completed | 36 | 619k | 34k | 0k | $0.02 | 10m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `circuit-fibsqrt` | 0.00 | completed | 4 | 22k | 32k | 0k | $0.02 | 5m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `break-filter-js-from-html` | 1.00 | completed | 13 | 74k | 14k | 0k | $0.00 | 2m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cobol-modernization` | 0.00 | timeout (timeout) | 30 | 430k | 59k | 0k | $0.01 | 15m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `build-cython-ext` | 0.00 | completed | 50 | 1.10M | 20k | 0k | $0.01 | 5m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `code-from-image` | 0.00 | completed | 50 | 1.10M | 51k | 0k | $0.04 | 8m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cancel-async-tasks` | 0.00 | timeout (timeout) | 29 | 319k | 58k | 0k | $0.01 | 15m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `compile-compcert` | 1.00 | completed | 50 | 741k | 20k | 0k | $0.01 | 24m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `adaptive-rejection-sampler` | 1.00 | completed | 24 | 606k | 27k | 0k | $0.07 | 10m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `chess-best-move` | 0.00 | completed (false finish) | 37 | 1.46M | 21k | 0k | $0.12 | 7m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `bn-fit-modify` | 0.00 | completed | 50 | 847k | 14k | 0k | $0.07 | 7m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `circuit-fibsqrt` | 0.00 | completed | 50 | 1.83M | 37k | 0k | $0.16 | 12m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `break-filter-js-from-html` | 0.00 | completed | 50 | 687k | 13k | 0k | $0.06 | 5m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cobol-modernization` | 1.00 | completed | 37 | 367k | 6k | 0k | $0.03 | 3m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `build-cython-ext` | 0.00 | completed | 50 | 1.11M | 5k | 0k | $0.08 | 4m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `code-from-image` | 0.00 | completed | 50 | 1.84M | 31k | 0k | $0.16 | 10m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cancel-async-tasks` | 1.00 | completed | 26 | 168k | 6k | 0k | $0.02 | 2m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `compile-compcert` | 1.00 | completed | 50 | 504k | 3k | 0k | $0.04 | 22m |

