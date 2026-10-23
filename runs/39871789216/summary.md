# Anchor benchmark results

Generated: 2026-10-23T01:02:14.769Z

| Bench | Model | Variant | Tasks | Full credit | Mean reward | False finish | Timeout | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | 9 | 5/7 (71.4%) | 0.714 | 1 | 1 | 7.27M | 244k | 6.57M | 90.4% | $0.34 | 7m | 16m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | 10 | 2/7 (28.6%) | 0.357 | 2 | 1 | 38.49M | 173k | 37.15M | 96.5% | $2.90 | 6m | 16m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 9/10 (90.0%) | 0.900 | 0 | 0 | 18.00M | 682k | 17.28M | 96.0% | $0.64 | 15m | 27m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | 10 | 5/10 (50.0%) | 0.500 | 5 | 0 | 49.03M | 192k | 47.38M | 96.6% | $3.67 | 11m | 14m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 5/10 (50.0%) | 0.500 | 0 | 1 | 6.03M | 341k | 5.45M | 90.3% | $0.45 | 4m | 17m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | 10 | 4/10 (40.0%) | 0.400 | 5 | 0 | 20.58M | 266k | 19.51M | 94.8% | $1.71 | 8m | 29m |

## Per task

| Bench | Model | Variant | Task | Reward | Status | Steps | Prompt tok | Completion tok | Cached tok | Cost | Wall |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `django__django-10914` | — | failed | 56 | 1.50M | 77k | 1.43M | $0.05 | 14m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `matplotlib__matplotlib-18869` | 1.00 | completed | 36 | 548k | 19k | 333k | $0.07 | 4m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `mwaskom__seaborn-2848` | 0.00 | timeout (timeout) | 32 | 761k | 19k | 675k | $0.03 | 16m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pallets__flask-4045` | — | failed | 34 | 579k | 18k | 552k | $0.02 | 3m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `psf__requests-1963` | 1.00 | completed | 27 | 419k | 18k | 395k | $0.01 | 4m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pylint-dev__pylint-5859` | 1.00 | completed | 32 | 438k | 19k | 395k | $0.02 | 8m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pytest-dev__pytest-11143` | 1.00 | completed | 34 | 507k | 24k | 479k | $0.02 | 7m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `sphinx-doc__sphinx-10325` | 1.00 | completed | 58 | 2.11M | 37k | 2.06M | $0.07 | 8m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `sympy__sympy-11400` | 0.00 | completed (false finish) | 32 | 415k | 13k | 253k | $0.06 | 2m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `django__django-10914` | — | failed | 100 | 4.02M | 11k | 3.87M | $0.30 | 5m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `matplotlib__matplotlib-18869` | 0.00 | completed (false finish) | 124 | 2.69M | 16k | 2.57M | $0.21 | 11m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `mwaskom__seaborn-2848` | 0.00 | completed | 37 | 697k | 4k | 627k | $0.06 | 2m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pallets__flask-4045` | — | failed | 151 | 6.17M | 15k | 6.00M | $0.45 | 7m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `psf__requests-1963` | 1.00 | completed | 57 | 1.27M | 15k | 1.18M | $0.11 | 5m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pydata__xarray-3364` | 0.50 | timeout (timeout) | 170 | 11.10M | 52k | 10.81M | $0.83 | 16m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pylint-dev__pylint-5859` | 0.00 | completed | 26 | 252k | 5k | 219k | $0.02 | 2m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pytest-dev__pytest-11143` | 1.00 | completed | 108 | 2.55M | 15k | 2.44M | $0.20 | 6m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sphinx-doc__sphinx-10325` | — | failed | 151 | 6.07M | 23k | 5.88M | $0.45 | 9m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sympy__sympy-11400` | 0.00 | completed (false finish) | 123 | 3.69M | 18k | 3.55M | $0.28 | 6m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 1.00 | completed | 64 | 2.02M | 47k | 1.88M | $0.05 | 16m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 1.00 | completed | 64 | 2.91M | 122k | 2.85M | $0.09 | 18m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed | 37 | 561k | 27k | 538k | $0.02 | 8m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed | 26 | 340k | 17k | 221k | $0.03 | 5m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 1.00 | completed | 26 | 553k | 19k | 521k | $0.02 | 7m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 0.00 | failed | 17 | 241k | 12k | 216k | $0.02 | 18m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 1.00 | completed | 62 | 1.75M | 33k | 1.71M | $0.03 | 11m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 1.00 | completed | 95 | 6.11M | 236k | 6.01M | $0.17 | 27m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed | 22 | 405k | 59k | 358k | $0.04 | 11m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 1.00 | completed | 76 | 3.11M | 111k | 2.98M | $0.17 | 15m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 0.00 | completed (false finish) | 149 | 8.37M | 22k | 8.15M | $0.61 | 10m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 0.00 | completed (false finish) | 97 | 5.23M | 31k | 5.04M | $0.40 | 12m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed | 74 | 1.72M | 13k | 1.62M | $0.14 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed | 46 | 1.03M | 13k | 936k | $0.09 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 0.00 | completed (false finish) | 108 | 5.57M | 15k | 5.36M | $0.41 | 13m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 1.00 | completed | 106 | 2.93M | 13k | 2.81M | $0.22 | 12m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 0.00 | completed (false finish) | 130 | 5.94M | 26k | 5.74M | $0.45 | 14m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 1.00 | completed | 169 | 12.36M | 23k | 12.09M | $0.90 | 9m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed | 27 | 552k | 7k | 478k | $0.05 | 3m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 0.00 | completed (false finish) | 105 | 5.34M | 29k | 5.16M | $0.41 | 11m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `adaptive-rejection-sampler` | 0.00 | completed | 7 | 25k | 33k | 20k | $0.02 | 3m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `chess-best-move` | 1.00 | completed | 69 | 2.73M | 88k | 2.60M | $0.15 | 13m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `bn-fit-modify` | 1.00 | completed | 37 | 504k | 42k | 453k | $0.03 | 8m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `circuit-fibsqrt` | 0.00 | completed | 6 | 33k | 32k | 28k | $0.02 | 4m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `break-filter-js-from-html` | 1.00 | completed | 10 | 52k | 6k | 42k | $0.01 | 2m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cobol-modernization` | 0.00 | timeout (timeout) | 32 | 451k | 43k | 291k | $0.07 | 15m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `build-cython-ext` | 0.00 | completed | 30 | 322k | 6k | 189k | $0.04 | 3m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `code-from-image` | 0.00 | completed | 4 | 37k | 0k | 5k | $0.01 | 0m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cancel-async-tasks` | 1.00 | completed | 26 | 221k | 48k | 208k | $0.06 | 4m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `compile-compcert` | 1.00 | completed | 77 | 1.66M | 42k | 1.61M | $0.04 | 17m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `adaptive-rejection-sampler` | 0.00 | completed | 15 | 54k | 0k | 42k | $0.00 | 1m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `chess-best-move` | 0.00 | completed (false finish) | 30 | 931k | 12k | 828k | $0.08 | 3m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `bn-fit-modify` | 1.00 | completed | 72 | 3.05M | 24k | 2.89M | $0.24 | 8m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `circuit-fibsqrt` | 0.00 | completed (false finish) | 86 | 3.12M | 133k | 2.97M | $0.33 | 29m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `break-filter-js-from-html` | 1.00 | completed | 148 | 2.28M | 17k | 2.18M | $0.18 | 8m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cobol-modernization` | 1.00 | completed | 91 | 1.66M | 16k | 1.58M | $0.13 | 5m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `build-cython-ext` | 0.00 | completed (false finish) | 83 | 3.07M | 8k | 2.93M | $0.23 | 5m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `code-from-image` | 0.00 | completed (false finish) | 77 | 5.55M | 50k | 5.28M | $0.44 | 12m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cancel-async-tasks` | 0.00 | completed (false finish) | 19 | 97k | 3k | 82k | $0.01 | 1m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `compile-compcert` | 1.00 | completed | 40 | 776k | 2k | 713k | $0.06 | 14m |

