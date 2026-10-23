#!/bin/bash
set -uo pipefail
cd /testbed || exit 1
git apply /tests/test_patch.patch || exit 1
PYTHON=/opt/miniconda3/envs/testbed/bin/python
if [ ! -x "$PYTHON" ]; then PYTHON=python; fi
"$PYTHON" -m pytest -q 'lib/matplotlib/tests/test_matplotlib.py::test_parse_to_version_info[3.5.0-version_tuple0]' 'lib/matplotlib/tests/test_matplotlib.py::test_parse_to_version_info[3.5.0rc2-version_tuple1]' 'lib/matplotlib/tests/test_matplotlib.py::test_parse_to_version_info[3.5.0.dev820+g6768ef8c4c-version_tuple2]' 'lib/matplotlib/tests/test_matplotlib.py::test_parse_to_version_info[3.5.0.post820+g6768ef8c4c-version_tuple3]' 'lib/matplotlib/tests/test_matplotlib.py::test_importable_with_no_home' 'lib/matplotlib/tests/test_matplotlib.py::test_use_doc_standard_backends' 'lib/matplotlib/tests/test_matplotlib.py::test_importable_with__OO'
code=$?
mkdir -p /logs/verifier
if [ "$code" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit "$code"
