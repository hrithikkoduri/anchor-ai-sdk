# Blueprint name dot check — DONE

Change (src/flask/blueprints.py):
- Blueprint.__init__: raise ValueError("'name' may not contain a dot '.' character.")
- Blueprint.add_url_rule: assert-based dot checks replaced with ValueError for
  endpoint ("'endpoint' may not contain a dot '.' character.") and view_func
  ("'view_func' name may not contain a dot '.' character.") — same as upstream
  2.0.1 commit 7c52614 for issue #4041.
- CHANGES.rst: changelog entry.

Verified:
- Repro (/tmp scratch script, since deleted) passes: Blueprint("app.ui") ->
  ValueError; bp.route(endpoint="a.b") and add_url_rule(endpoint/view_func with
  dot) -> ValueError; normal blueprint url_defaults still works.
- Ran upstream 2.0.1 versions of the updated tests against this tree:
  test_dotted_name_not_allowed PASS, test_route_decorator_custom_endpoint_with_dots
  PASS, test_basic.py::test_inject_blueprint_url_defaults PASS.
- Full tests/ FAILED set identical before/after change (251 pre-existing failures
  caused by Werkzeug 2.3.7 vs Flask 2.0 ranked API: `as_tuple`, `__init__`
  TypeError, DeprecationWarning-as-error). Environment is not matched to the repo
  pin; unrelated to this change.

Obsolete pre-change repo tests that now fail by design (upstream deleted/changed
them in the same commit): tests/test_blueprints.py::test_dotted_names and
tests/test_basic.py::test_inject_blueprint_url_defaults (uses
Blueprint("foo.bar.baz")). Per instructions, test files were not modified.
