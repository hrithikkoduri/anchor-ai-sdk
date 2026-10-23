#!/bin/bash
set -uo pipefail
cd /testbed || exit 1
git apply /tests/test_patch.patch || exit 1
PYTHON=/opt/miniconda3/envs/testbed/bin/python
if [ ! -x "$PYTHON" ]; then PYTHON=python; fi
"$PYTHON" -m pytest -q 'tests/checkers/unittest_misc.py::TestFixme::test_non_alphanumeric_codetag' 'tests/checkers/unittest_misc.py::TestFixme::test_fixme_with_message' 'tests/checkers/unittest_misc.py::TestFixme::test_todo_without_message' 'tests/checkers/unittest_misc.py::TestFixme::test_xxx_without_space' 'tests/checkers/unittest_misc.py::TestFixme::test_xxx_middle' 'tests/checkers/unittest_misc.py::TestFixme::test_without_space_fixme' 'tests/checkers/unittest_misc.py::TestFixme::test_absent_codetag' 'tests/checkers/unittest_misc.py::TestFixme::test_other_present_codetag' 'tests/checkers/unittest_misc.py::TestFixme::test_issue_2321_should_not_trigger' 'tests/checkers/unittest_misc.py::TestFixme::test_issue_2321_should_trigger' 'tests/checkers/unittest_misc.py::TestFixme::test_dont_trigger_on_todoist'
code=$?
mkdir -p /logs/verifier
if [ "$code" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit "$code"
