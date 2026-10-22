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

## Per task

| Bench | Model | Variant | Task | Reward | Status | Steps | Prompt tok | Completion tok | Cached tok | Cost | Wall |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `django__django-10914` | 0.00 | completed (false finish) | 41 | 934k | 36k | 899k | $0.03 | 5m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `matplotlib__matplotlib-18869` | 1.00 | completed | 35 | 614k | 16k | 585k | $0.02 | 3m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `mwaskom__seaborn-2848` | 1.00 | timeout (timeout) | 36 | 860k | 43k | 822k | $0.03 | 17m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pallets__flask-4045` | 1.00 | completed | 37 | 760k | 15k | 663k | $0.03 | 4m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `psf__requests-1963` | 1.00 | completed | 39 | 658k | 36k | 632k | $0.02 | 5m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pydata__xarray-3364` | 1.00 | completed | 36 | 888k | 22k | 850k | $0.04 | 4m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pylint-dev__pylint-5859` | 1.00 | completed | 35 | 452k | 27k | 380k | $0.03 | 6m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pytest-dev__pytest-11143` | 1.00 | completed | 29 | 474k | 19k | 451k | $0.01 | 5m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `sphinx-doc__sphinx-10325` | — | failed | 47 | 1.15M | 34k | 1.11M | $0.06 | 4m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `sympy__sympy-11400` | 0.00 | completed (false finish) | 41 | 792k | 22k | 761k | $0.03 | 6m |
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
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 1.00 | completed | 69 | 1.90M | 36k | 1.83M | $0.04 | 11m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 1.00 | completed | 45 | 1.41M | 80k | 1.36M | $0.05 | 13m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed | 40 | 631k | 34k | 606k | $0.02 | 8m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed | 38 | 794k | 31k | 762k | $0.02 | 6m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 1.00 | completed | 40 | 917k | 30k | 844k | $0.03 | 11m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 1.00 | completed | 95 | 3.70M | 109k | 3.19M | $0.24 | 28m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 1.00 | completed | 70 | 2.16M | 39k | 2.11M | $0.04 | 11m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 1.00 | completed | 98 | 4.92M | 241k | 4.84M | $0.16 | 26m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed | 22 | 414k | 46k | 387k | $0.03 | 9m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 1.00 | completed | 88 | 4.00M | 127k | 3.93M | $0.10 | 49m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 0.00 | completed | 187 | 9.19M | 25k | 9.06M | $0.67 | 19m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 0.00 | failed | 41 | 1.24M | 3k | 1.18M | $0.09 | 3m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed | 53 | 1.68M | 17k | 1.61M | $0.14 | 6m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 0.00 | completed | 47 | 1.41M | 10k | 1.36M | $0.11 | 7m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 1.00 | completed | 119 | 5.68M | 20k | 5.57M | $0.42 | 9m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 0.00 | completed (false finish) | 103 | 5.57M | 25k | 5.46M | $0.42 | 15m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed | 64 | 1.36M | 14k | 1.30M | $0.11 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed | 55 | 1.41M | 15k | 1.34M | $0.11 | 5m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 0.00 | completed | 123 | 6.96M | 15k | 6.83M | $0.51 | 16m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 1.00 | completed | 38 | 643k | 4k | 610k | $0.05 | 6m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `adaptive-rejection-sampler` | 0.00 | completed | 7 | 22k | 33k | 20k | $0.02 | 4m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `chess-best-move` | 1.00 | completed | 40 | 979k | 63k | 878k | $0.05 | 13m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `bn-fit-modify` | 1.00 | completed | 46 | 595k | 26k | 571k | $0.02 | 6m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `circuit-fibsqrt` | 0.00 | completed | 4 | 20k | 32k | 15k | $0.02 | 3m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `break-filter-js-from-html` | 1.00 | completed | 13 | 69k | 14k | 55k | $0.01 | 2m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cobol-modernization` | 0.00 | completed | 43 | 1.07M | 109k | 801k | $0.14 | 14m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `build-cython-ext` | 1.00 | completed | 92 | 2.98M | 27k | 2.76M | $0.13 | 8m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `code-from-image` | 1.00 | completed | 24 | 125k | 7k | 105k | $0.01 | 3m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cancel-async-tasks` | 1.00 | completed | 33 | 490k | 64k | 465k | $0.04 | 8m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `compile-compcert` | 1.00 | completed | 63 | 1.03M | 22k | 1.00M | $0.02 | 17m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `adaptive-rejection-sampler` | 1.00 | completed | 31 | 877k | 43k | 812k | $0.10 | 14m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `chess-best-move` | 0.00 | completed (false finish) | 39 | 1.43M | 31k | 1.36M | $0.13 | 8m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `bn-fit-modify` | 0.00 | completed (false finish) | 44 | 922k | 13k | 869k | $0.08 | 5m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `circuit-fibsqrt` | 0.00 | completed (false finish) | 140 | 5.74M | 75k | 5.60M | $0.47 | 19m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `break-filter-js-from-html` | 0.00 | completed | 160 | 5.71M | 36k | 5.61M | $0.43 | 15m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cobol-modernization` | 0.00 | completed | 31 | 220k | 4k | 203k | $0.02 | 2m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `build-cython-ext` | 0.00 | completed (false finish) | 128 | 4.29M | 19k | 4.20M | $0.32 | 10m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `code-from-image` | 0.00 | completed (false finish) | 71 | 4.10M | 61k | 3.95M | $0.34 | 17m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cancel-async-tasks` | 0.00 | completed | 31 | 174k | 5k | 158k | $0.02 | 2m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `compile-compcert` | 0.00 | completed | 22 | 77k | 1k | 69k | $0.01 | 1m |

