# Task: rewrite crash when first expression of file is a number (mistaken as docstring) — DONE

Repro before fix: file starting with `200` + `assert 1 == 2` -> collection error
`TypeError: argument of type 'int' is not iterable` (rewrite.py run() -> is_rewrite_disabled).

Root cause: `run()` treated ANY leading `ast.Constant` as module docstring; `is_rewrite_disabled`
does `"PYTEST_DONT_REWRITE" in doc` -> crashes on non-str constants. Same as upstream #11140.

Fix: require `isinstance(item.value.value, str)` in the docstring-detection branch
(src/_pytest/assertion/rewrite.py) + changelog/11140.bugfix.rst (bugfix).

Verified after fix:
- repro with 200: no collection error, assert rewritten (`assert 1 == 2`).
- report's exact scenario `pytest -k xxx` on such a file: 1 deselected, exit 0, no TypeError.
- matrix over first constants 0/200/3.14/None/False/b".."/.../(1,2)/[1]/f".."/u'PYTEST_DONT_REWRITE':
  all run; non-str constants get rewritten asserts; only real str `'PYTEST_DONT_REWRITE'` disables
  rewriting (plain AssertionError with no explanation).
- upstream regression test TestIssue11140::test_constant_not_picked_as_module_docstring passes.
- testing/test_assertrewrite.py 115 passed; +test_collection.py +testing/python (minus metafunc.py,
  needs missing hypothesis) = 578 passed, 22 skipped, 2 xfailed.
- full testing/ run (minus metafunc.py/test_junitxml.py — missing hypothesis/xmlschema, and
  test_assertion.py — attrs not installed): 2965 passed, 8 failed; all 8 failures reproduce
  identically on the stashed (unmodified) tree -> pre-existing environment issues (pygments/attrs).

Env note: a stray attrs install during debugging was uninstalled again; env left as found.
