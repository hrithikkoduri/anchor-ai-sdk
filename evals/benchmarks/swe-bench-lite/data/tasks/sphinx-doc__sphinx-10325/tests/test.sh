#!/bin/bash
set -uo pipefail
cd /testbed || exit 1
git apply /tests/test_patch.patch || exit 1
PYTHON=/opt/miniconda3/envs/testbed/bin/python
if [ ! -x "$PYTHON" ]; then PYTHON=python; fi
"$PYTHON" -m pytest -q 'tests/test_ext_autodoc_automodule.py::test_automodule_inherited_members' 'tests/test_ext_autodoc_automodule.py::test_empty_all' 'tests/test_ext_autodoc_automodule.py::test_automodule' 'tests/test_ext_autodoc_automodule.py::test_automodule_undoc_members' 'tests/test_ext_autodoc_automodule.py::test_automodule_special_members' 'tests/test_ext_autodoc_automodule.py::test_subclass_of_mocked_object'
code=$?
mkdir -p /logs/verifier
if [ "$code" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit "$code"
