#!/bin/bash
set -uo pipefail
cd /testbed || exit 1
git apply /tests/test_patch.patch || exit 1
python -m pytest -q 'xarray/tests/test_combine.py::TestAutoCombineOldAPI::test_auto_combine_with_new_variables' 'xarray/tests/test_concat.py::TestConcatDataset::test_concat_merge_variables_present_in_some_datasets'
code=$?
mkdir -p /logs/verifier
if [ "$code" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit "$code"
