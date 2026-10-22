#!/bin/bash
set -uo pipefail
cd /testbed || exit 1
git apply /tests/test_patch.patch || exit 1
python -m pytest -q 'test_requests.py::RequestsTestCase::test_DIGESTAUTH_QUOTES_QOP_VALUE' 'test_requests.py::RequestsTestCase::test_DIGESTAUTH_WRONG_HTTP_401_GET' 'test_requests.py::RequestsTestCase::test_DIGEST_AUTH_RETURNS_COOKIE' 'test_requests.py::RequestsTestCase::test_DIGEST_HTTP_200_OK_GET' 'test_requests.py::RequestsTestCase::test_POSTBIN_GET_POST_FILES_WITH_DATA' 'test_requests.py::RequestsTestCase::test_param_cookiejar_works' 'test_requests.py::TestRedirects::test_requests_are_updated_each_time'
code=$?
mkdir -p /logs/verifier
if [ "$code" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
exit "$code"
