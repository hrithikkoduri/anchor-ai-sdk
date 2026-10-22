#!/bin/bash
set -uo pipefail
cd /testbed || exit 1
git apply /tests/test_patch.patch || exit 1
python -m pytest -q 'lib/matplotlib/tests/test_matplotlib.py::test_parse_to_version_info[3.5.0-version_tuple0]' 'lib/matplotlib/tests/test_matplotlib.py::test_parse_to_version_info[3.5.0rc2-version_tuple1]' 'lib/matplotlib/tests/test_matplotlib.py::test_parse_to_version_info[3.5.0.dev820+g6768ef8c4c-version_tuple2]' 'lib/matplotlib/tests/test_matplotlib.py::test_parse_to_version_info[3.5.0.post820+g6768ef8c4c-version_tuple3]'
code=$?
mkdir -p /logs/verifier
if [ "$code" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit "$code"
