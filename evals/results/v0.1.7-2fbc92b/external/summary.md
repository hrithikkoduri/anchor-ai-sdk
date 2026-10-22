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

## Per task

| Bench | Model | Task | Reward | Status |
|---|---|---|---:|---|
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/django__django-10914` | 0.00 | completed |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/matplotlib__matplotlib-18869` | 0.00 | completed |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/mwaskom__seaborn-2848` | 0.00 | completed |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/pallets__flask-4045` | 0.00 | completed |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/psf__requests-1963` | 0.00 | completed |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/pydata__xarray-3364` | 0.00 | failed: Agent execution timed out after 1800.0 seconds |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/pylint-dev__pylint-5859` | 0.00 | completed |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/pytest-dev__pytest-11143` | 0.00 | completed |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/sphinx-doc__sphinx-10325` | 0.00 | completed |
| swe-lite | `deepseek/deepseek-v4.1-flash-1017` | `swe-bench-lite/sympy__sympy-11400` | 0.00 | completed |
| swe-lite | `qwen/qwen3-coder-next` | `swe-bench-lite/django__django-10914` | 0.00 | failed: Agent execution timed out after 1800.0 seconds |
| swe-lite | `qwen/qwen3-coder-next` | `swe-bench-lite/matplotlib__matplotlib-18869` | 0.00 | completed |
| swe-lite | `qwen/qwen3-coder-next` | `swe-bench-lite/mwaskom__seaborn-2848` | 0.00 | completed |
| swe-lite | `qwen/qwen3-coder-next` | `swe-bench-lite/pallets__flask-4045` | 0.00 | completed |
| swe-lite | `qwen/qwen3-coder-next` | `swe-bench-lite/psf__requests-1963` | 0.00 | completed |
| swe-lite | `qwen/qwen3-coder-next` | `swe-bench-lite/pydata__xarray-3364` | 0.00 | completed |
| swe-lite | `qwen/qwen3-coder-next` | `swe-bench-lite/pylint-dev__pylint-5859` | 0.00 | completed |
| swe-lite | `qwen/qwen3-coder-next` | `swe-bench-lite/pytest-dev__pytest-11143` | 0.00 | completed |
| swe-lite | `qwen/qwen3-coder-next` | `swe-bench-lite/sphinx-doc__sphinx-10325` | 0.00 | completed |
| swe-lite | `qwen/qwen3-coder-next` | `swe-bench-lite/sympy__sympy-11400` | 0.00 | completed |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 1.00 | completed |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 0.00 | completed |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 1.00 | completed |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 0.00 | completed |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 1.00 | completed |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 0.00 | failed: Agent execution timed out after 6000.0 seconds |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed |
| swe-pro | `deepseek/deepseek-v4.1-flash-1017` | `swebench-pro/instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 0.00 | completed |
| swe-pro | `qwen/qwen3-coder-next` | `swebench-pro/instance_flipt-io__flipt-02e21636c58e86c51119b63e0fb5ca7b813b07b1` | 0.00 | completed |
| swe-pro | `qwen/qwen3-coder-next` | `swebench-pro/instance_qutebrowser__qutebrowser-01d1d1494411380d97cac14614a829d3a69cecaf-v2ef375ac784985212b1805e1d0431dc8f1b3c171` | 0.00 | completed |
| swe-pro | `qwen/qwen3-coder-next` | `swebench-pro/instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c` | 1.00 | completed |
| swe-pro | `qwen/qwen3-coder-next` | `swebench-pro/instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029` | 0.00 | completed |
| swe-pro | `qwen/qwen3-coder-next` | `swebench-pro/instance_NodeBB__NodeBB-00c70ce7b0541cfc94afe567921d7668cdc8f4ac-vnan` | 0.00 | completed |
| swe-pro | `qwen/qwen3-coder-next` | `swebench-pro/instance_gravitational__teleport-005dcb16bacc6a5d5890c4cd302ccfd4298e275d-vee9b09fb20c43af7e520f57e9239bbcf46b7113d` | 0.00 | completed |
| swe-pro | `qwen/qwen3-coder-next` | `swebench-pro/instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2` | 1.00 | completed |
| swe-pro | `qwen/qwen3-coder-next` | `swebench-pro/instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26` | 1.00 | completed |
| swe-pro | `qwen/qwen3-coder-next` | `swebench-pro/instance_element-hq__element-web-1077729a19c0ce902e713cf6fab42c91fb7907f1-vnan` | 0.00 | completed |
| swe-pro | `qwen/qwen3-coder-next` | `swebench-pro/instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e` | 0.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/adaptive-rejection-sampler` | 0.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/chess-best-move` | 1.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/bn-fit-modify` | 1.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/circuit-fibsqrt` | 1.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/break-filter-js-from-html` | 1.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/cobol-modernization` | 1.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/build-cython-ext` | 1.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/code-from-image` | 1.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/cancel-async-tasks` | 0.00 | completed |
| terminal-bench | `deepseek/deepseek-v4.1-flash-1017` | `terminal-bench/compile-compcert` | 1.00 | completed |
| terminal-bench | `qwen/qwen3-coder-next` | `terminal-bench/adaptive-rejection-sampler` | 0.00 | failed: Agent execution timed out after 900.0 seconds |
| terminal-bench | `qwen/qwen3-coder-next` | `terminal-bench/chess-best-move` | 0.00 | completed |
| terminal-bench | `qwen/qwen3-coder-next` | `terminal-bench/bn-fit-modify` | 0.00 | completed |
| terminal-bench | `qwen/qwen3-coder-next` | `terminal-bench/circuit-fibsqrt` | 0.00 | failed: litellm.APIError: APIError: OpenrouterException - {"error":{"message":"This request would exceed your available credits  |
| terminal-bench | `qwen/qwen3-coder-next` | `terminal-bench/break-filter-js-from-html` | 1.00 | completed |
| terminal-bench | `qwen/qwen3-coder-next` | `terminal-bench/cobol-modernization` | 1.00 | completed |
| terminal-bench | `qwen/qwen3-coder-next` | `terminal-bench/build-cython-ext` | 0.00 | completed |
| terminal-bench | `qwen/qwen3-coder-next` | `terminal-bench/code-from-image` | 1.00 | completed |
| terminal-bench | `qwen/qwen3-coder-next` | `terminal-bench/cancel-async-tasks` | 0.00 | completed |
| terminal-bench | `qwen/qwen3-coder-next` | `terminal-bench/compile-compcert` | 0.00 | completed |

