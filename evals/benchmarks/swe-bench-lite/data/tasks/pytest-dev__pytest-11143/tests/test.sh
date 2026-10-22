#!/bin/bash
set -uo pipefail
cd /testbed || exit 1
git apply /tests/test_patch.patch || exit 1
python -m pytest -q 'testing/test_assertrewrite.py::TestIssue11140::test_constant_not_picked_as_module_docstring'
code=$?
mkdir -p /logs/verifier
if [ "$code" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit "$code"
