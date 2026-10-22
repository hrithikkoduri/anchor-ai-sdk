# Issue 11140 — rewrite crash when first statement is a non-string constant

Verified facts
- Repro before fix: pytest on files starting with `1`, `b"hello"`, `None` -> collection ERROR
  `TypeError: argument of type 'int' is not iterable` at AssertionRewriter.run -> is_rewrite_disabled.
- Root cause: `run()` treated any leading `ast.Constant` as module docstring; `mod.docstring`
  does not exist on this Python so the first-stmt branch always ran.
- Fix: require `isinstance(item.value.value, str)` in the docstring detection condition
  (matches upstream pytest 8.0.0 source exactly).
- Added changelog/11140.bugfix.rst with upstream's wording.

Verification
- /tmp/repro11073 (int/bytes/None/real-docstring first) -> 4 passed.
- /tmp/repro2 assertions still rewritten (failures show rewritten messages, no collection errors).
- Upstream regression test TestIssue11140 copied to /tmp/t11140 -> passed.
- testing/test_assertrewrite.py + test_collection + test_pytester + test_config + test_main -> 452 passed.
- Whole testing/ (minus test_assertion.py, test_junitxml.py, python/metafunc.py: missing attr/xmlschema/hypothesis):
  8 failed, 2965 passed — the same 8 failures occur on the pristine tree (pygments/attrs env), unrelated.
