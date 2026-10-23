#!/bin/bash
set -uo pipefail
cd /testbed || exit 1
git apply /tests/test_patch.patch || exit 1
PYTHON=/opt/miniconda3/envs/testbed/bin/python
if [ ! -x "$PYTHON" ]; then PYTHON=python; fi
"$PYTHON" -m pytest -q 'test_ccode_Relational' 'test_ccode_sinc' 'test_printmethod' 'test_ccode_sqrt' 'test_ccode_Pow' 'test_ccode_constants_mathh' 'test_ccode_constants_other' 'test_ccode_Rational' 'test_ccode_Integer' 'test_ccode_functions' 'test_ccode_inline_function' 'test_ccode_exceptions' 'test_ccode_user_functions' 'test_ccode_boolean' 'test_ccode_Piecewise' 'test_ccode_Piecewise_deep' 'test_ccode_ITE' 'test_ccode_settings' 'test_ccode_Indexed' 'test_ccode_Indexed_without_looking_for_contraction' 'test_ccode_loops_matrix_vector' 'test_dummy_loops' 'test_ccode_loops_add' 'test_ccode_loops_multiple_contractions' 'test_ccode_loops_addfactor' 'test_ccode_loops_multiple_terms' 'test_dereference_printing' 'test_Matrix_printing' 'test_ccode_reserved_words' 'test_ccode_sign' 'test_ccode_Assignment'
code=$?
mkdir -p /logs/verifier
if [ "$code" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit "$code"
