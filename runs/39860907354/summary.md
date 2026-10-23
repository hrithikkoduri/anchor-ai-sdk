# Anchor benchmark results

Generated: 2026-10-23T00:17:48.342Z

| Bench | Model | Variant | Tasks | Full credit | Mean reward | False finish | Timeout | Prompt tok | Completion tok | Cached tok | Cache hit | Cost | p50 | p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | 6 | 5/6 (83.3%) | 0.976 | 0 | 0 | 4.50M | 145k | 4.31M | 95.8% | $0.16 | 6m | 12m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | 9 | 2/7 (28.6%) | 0.408 | 2 | 0 | 22.33M | 113k | 21.44M | 96.0% | $1.70 | 6m | 10m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 10/10 (100.0%) | 1.000 | 0 | 0 | 22.64M | 915k | 20.82M | 91.9% | $0.91 | 17m | 34m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | 10 | 2/10 (20.0%) | 0.200 | 3 | 0 | 17.62M | 107k | 16.69M | 94.7% | $1.37 | 4m | 30m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 5/10 (50.0%) | 0.500 | 0 | 1 | 10.35M | 494k | 9.13M | 88.2% | $0.77 | 5m | 16m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | 10 | 6/10 (60.0%) | 0.600 | 3 | 1 | 18.82M | 286k | 17.96M | 95.4% | $1.59 | 7m | 37m |

## Per task

| Bench | Model | Variant | Task | Reward | Status | Steps | Prompt tok | Completion tok | Cached tok | Cost | Wall |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `mwaskom__seaborn-2848` | 1.00 | completed | 32 | 593k | 24k | 533k | $0.02 | 12m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pallets__flask-4045` | 1.00 | completed | 43 | 861k | 23k | 831k | $0.02 | 5m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `psf__requests-1963` | 0.86 | completed | 9 | 55k | 5k | 47k | $0.00 | 2m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pylint-dev__pylint-5859` | 1.00 | completed | 34 | 422k | 22k | 402k | $0.02 | 5m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pytest-dev__pytest-11143` | 1.00 | completed | 44 | 851k | 25k | 822k | $0.02 | 7m |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `sphinx-doc__sphinx-10325` | 1.00 | completed | 62 | 1.72M | 46k | 1.68M | $0.08 | 6m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `django__django-10914` | — | failed | 143 | 4.01M | 16k | 3.88M | $0.30 | 7m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `matplotlib__matplotlib-18869` | 0.00 | completed (false finish) | 83 | 1.64M | 10k | 1.56M | $0.13 | 6m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `mwaskom__seaborn-2848` | 0.00 | completed | 41 | 1.02M | 3k | 923k | $0.08 | 3m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pallets__flask-4045` | — | failed | 85 | 2.06M | 8k | 1.99M | $0.15 | 5m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `psf__requests-1963` | 0.86 | completed | 34 | 436k | 8k | 406k | $0.04 | 4m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pylint-dev__pylint-5859` | 1.00 | completed | 91 | 2.44M | 23k | 2.33M | $0.19 | 8m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pytest-dev__pytest-11143` | 0.00 | completed | 31 | 365k | 4k | 341k | $0.03 | 2m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sphinx-doc__sphinx-10325` | 1.00 | completed | 143 | 6.38M | 27k | 6.18M | $0.48 | 10m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sympy__sympy-11400` | 0.00 | completed (false finish) | 128 | 3.98M | 14k | 3.84M | $0.30 | 6m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 1.00 | completed | 74 | 2.73M | 63k | 2.46M | $0.08 | 15m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 1.00 | completed | 70 | 2.83M | 128k | 2.11M | $0.13 | 33m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed | 30 | 390k | 21k | 370k | $0.01 | 6m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed | 29 | 433k | 22k | 381k | $0.02 | 5m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 1.00 | completed | 28 | 671k | 12k | 637k | $0.02 | 8m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 1.00 | completed | 76 | 2.82M | 101k | 2.48M | $0.20 | 23m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 1.00 | completed | 63 | 1.84M | 41k | 1.76M | $0.05 | 14m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 1.00 | completed | 138 | 7.96M | 307k | 7.86M | $0.22 | 34m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed | 39 | 1.03M | 91k | 897k | $0.07 | 17m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 1.00 | completed | 62 | 1.93M | 129k | 1.86M | $0.09 | 21m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 0.00 | completed | 49 | 1.00M | 3k | 930k | $0.08 | 3m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 0.00 | completed (false finish) | 71 | 2.90M | 28k | 2.75M | $0.23 | 12m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 0.00 | failed | 43 | 825k | 4k | 764k | $0.06 | 3m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 0.00 | completed (false finish) | 43 | 776k | 12k | 700k | $0.07 | 4m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 0.00 | failed | 20 | 326k | 1k | 297k | $0.03 | 3m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 1.00 | completed | 65 | 1.80M | 9k | 1.69M | $0.14 | 7m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 0.00 | failed | 13 | 124k | 1k | 104k | $0.01 | 3m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 0.00 | completed | 42 | 1.13M | 5k | 1.08M | $0.09 | 3m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed | 72 | 2.79M | 20k | 2.64M | $0.22 | 8m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 0.00 | completed (false finish) | 112 | 5.95M | 25k | 5.75M | $0.45 | 30m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `adaptive-rejection-sampler` | 0.00 | completed | 5 | 15k | 32k | 12k | $0.02 | 5m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `chess-best-move` | 1.00 | completed | 73 | 2.50M | 92k | 2.39M | $0.08 | 12m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `bn-fit-modify` | 1.00 | completed | 37 | 501k | 35k | 473k | $0.02 | 7m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `circuit-fibsqrt` | 0.00 | completed | 8 | 52k | 46k | 44k | $0.02 | 4m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `break-filter-js-from-html` | 0.00 | completed | 11 | 42k | 20k | 32k | $0.01 | 3m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cobol-modernization` | 1.00 | timeout (timeout) | 101 | 3.98M | 164k | 3.37M | $0.33 | 16m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `build-cython-ext` | 1.00 | completed | 93 | 3.14M | 30k | 2.72M | $0.18 | 7m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `code-from-image` | 1.00 | completed | 15 | 56k | 3k | 42k | $0.01 | 1m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cancel-async-tasks` | 0.00 | completed | 8 | 37k | 69k | 30k | $0.09 | 5m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `compile-compcert` | 0.00 | completed | 8 | 23k | 1k | 18k | $0.00 | 1m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `adaptive-rejection-sampler` | 1.00 | timeout (timeout) | 65 | 2.61M | 61k | 2.51M | $0.24 | 15m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `chess-best-move` | 0.00 | completed (false finish) | 43 | 1.63M | 32k | 1.55M | $0.14 | 8m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `bn-fit-modify` | 0.00 | completed (false finish) | 63 | 1.27M | 18k | 1.20M | $0.11 | 7m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `circuit-fibsqrt` | 0.00 | completed (false finish) | 99 | 6.84M | 141k | 6.56M | $0.61 | 37m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `break-filter-js-from-html` | 0.00 | completed | 26 | 216k | 7k | 199k | $0.02 | 3m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cobol-modernization` | 1.00 | completed | 28 | 236k | 5k | 218k | $0.02 | 2m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `build-cython-ext` | 1.00 | completed | 123 | 3.92M | 12k | 3.79M | $0.29 | 7m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `code-from-image` | 1.00 | completed | 17 | 388k | 2k | 331k | $0.03 | 1m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cancel-async-tasks` | 1.00 | completed | 19 | 79k | 2k | 64k | $0.01 | 1m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `compile-compcert` | 1.00 | completed | 78 | 1.62M | 6k | 1.53M | $0.12 | 22m |

