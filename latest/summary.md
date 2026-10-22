# Anchor benchmark results

Generated: 2026-10-22T07:34:41.262Z

| Bench | Model | Variant | Tasks | Full credit | Mean reward | False finish | Timeout | Cost | p50 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 8/10 (80.0%) | 0.800 | 1 | 1 | $0.18 | 7m |
| swe-lite | `qwen/qwen3-coder-next` | baseline | 10 | 2/9 (22.2%) | 0.222 | 0 | 0 | $0.57 | 3m |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 8/10 (80.0%) | 0.800 | 0 | 0 | $0.27 | 11m |
| swe-pro | `qwen/qwen3-coder-next` | baseline | 10 | 4/10 (40.0%) | 0.400 | 1 | 0 | $0.99 | 6m |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | 10 | 3/10 (30.0%) | 0.300 | 0 | 2 | $0.16 | 10m |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | 10 | 4/10 (40.0%) | 0.400 | 1 | 0 | $0.80 | 7m |

## Per task

| Bench | Model | Variant | Task | Reward | Status | Steps | Cost |
|---|---|---|---|---:|---|---:|---:|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `django__django-10914` | 0.00 | completed | 50 | $0.01 |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `matplotlib__matplotlib-18869` | 1.00 | completed | 28 | $0.01 |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `mwaskom__seaborn-2848` | 1.00 | timeout (timeout) | 28 | $0.01 |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pallets__flask-4045` | 1.00 | completed | 42 | $0.02 |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `psf__requests-1963` | 1.00 | completed | 45 | $0.01 |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pydata__xarray-3364` | 1.00 | completed | 50 | $0.06 |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pylint-dev__pylint-5859` | 1.00 | completed | 17 | $0.01 |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `pytest-dev__pytest-11143` | 1.00 | completed | 39 | $0.01 |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `sphinx-doc__sphinx-10325` | 1.00 | completed | 47 | $0.03 |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | baseline | `sympy__sympy-11400` | 0.00 | completed (false finish) | 30 | $0.01 |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `django__django-10914` | — | failed | 50 | $0.07 |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `matplotlib__matplotlib-18869` | 0.00 | completed | 50 | $0.05 |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `mwaskom__seaborn-2848` | 0.00 | completed | 36 | $0.04 |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pallets__flask-4045` | 0.00 | completed | 50 | $0.05 |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `psf__requests-1963` | 1.00 | completed | 32 | $0.03 |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pydata__xarray-3364` | 0.00 | completed | 50 | $0.08 |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pylint-dev__pylint-5859` | 0.00 | completed | 50 | $0.07 |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `pytest-dev__pytest-11143` | 1.00 | completed | 50 | $0.06 |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sphinx-doc__sphinx-10325` | 0.00 | completed | 50 | $0.06 |
| swe-lite | `qwen/qwen3-coder-next` | baseline | `sympy__sympy-11400` | 0.00 | completed | 50 | $0.07 |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 1.00 | completed | 50 | $0.03 |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 1.00 | completed | 50 | $0.02 |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed | 50 | $0.01 |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed | 47 | $0.02 |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 1.00 | completed | 42 | $0.03 |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 0.00 | completed | 50 | $0.04 |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 1.00 | completed | 50 | $0.02 |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 1.00 | completed | 50 | $0.05 |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed | 16 | $0.02 |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 0.00 | completed | 50 | $0.04 |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 0.00 | completed (false finish) | 28 | $0.03 |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 0.00 | completed | 50 | $0.12 |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed | 50 | $0.08 |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed | 43 | $0.06 |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 0.00 | completed | 50 | $0.14 |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 1.00 | completed | 50 | $0.08 |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 0.00 | completed | 50 | $0.09 |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 0.00 | completed | 50 | $0.15 |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed | 50 | $0.12 |
| swe-pro | `qwen/qwen3-coder-next` | baseline | `instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 0.00 | completed | 50 | $0.12 |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `adaptive-rejection-sampler` | 0.00 | completed | 5 | $0.01 |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `chess-best-move` | 0.00 | completed | 50 | $0.03 |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `bn-fit-modify` | 1.00 | completed | 36 | $0.02 |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `circuit-fibsqrt` | 0.00 | completed | 4 | $0.02 |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `break-filter-js-from-html` | 1.00 | completed | 13 | $0.00 |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cobol-modernization` | 0.00 | timeout (timeout) | 30 | $0.01 |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `build-cython-ext` | 0.00 | completed | 50 | $0.01 |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `code-from-image` | 0.00 | completed | 50 | $0.04 |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `cancel-async-tasks` | 0.00 | timeout (timeout) | 29 | $0.01 |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | baseline | `compile-compcert` | 1.00 | completed | 50 | $0.01 |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `adaptive-rejection-sampler` | 1.00 | completed | 24 | $0.07 |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `chess-best-move` | 0.00 | completed (false finish) | 37 | $0.12 |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `bn-fit-modify` | 0.00 | completed | 50 | $0.07 |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `circuit-fibsqrt` | 0.00 | completed | 50 | $0.16 |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `break-filter-js-from-html` | 0.00 | completed | 50 | $0.06 |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cobol-modernization` | 1.00 | completed | 37 | $0.03 |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `build-cython-ext` | 0.00 | completed | 50 | $0.08 |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `code-from-image` | 0.00 | completed | 50 | $0.16 |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `cancel-async-tasks` | 1.00 | completed | 26 | $0.02 |
| terminal-bench | `qwen/qwen3-coder-next` | baseline | `compile-compcert` | 1.00 | completed | 50 | $0.04 |

