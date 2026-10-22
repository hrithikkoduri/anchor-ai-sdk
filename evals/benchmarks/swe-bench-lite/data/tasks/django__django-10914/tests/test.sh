#!/bin/bash
set -uo pipefail
cd /testbed || exit 1
git apply /tests/test_patch.patch || exit 1
python -m pytest -q 'test_override_file_upload_permissions (test_utils.tests.OverrideSettingsTests)'
code=$?
mkdir -p /logs/verifier
if [ "$code" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit "$code"
