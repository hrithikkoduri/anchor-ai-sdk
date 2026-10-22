# Add easily comparable version info to toplevel

## Verified facts
- base commit b7d059198: matplotlib/__init__.py only exposed lazy `__version__` via module `__getattr__`.
- Upstream solution (matplotlib PR #18869, commit adbc5c5): namedtuple `__version_info__`
  modelled after sys.version_info (major, minor, micro, releaselevel, serial), via
  `_VersionInfo`, `_parse_to_version_info()`, `_get_version()` + extended `__getattr__`.
- Implemented exactly that, plus doc/users/next_whats_new/version_info.rst.

## Verified checks (this run)
- upstream test cases of test_parse_to_version_info pass:
  ('3.5.0'->(3,5,0,'final',0)), ('3.5.0rc2'->candidate 2),
  ('3.5.0.dev820+g6768ef8c4c'->alpha 820), ('3.5.0.post820+g6768ef8c4c'->(3,5,1,'alpha',820))
- `matplotlib.__version_info__` == `_parse_to_version_info(__version__)`; comparable to plain tuples.
- cached on first access; accessing __version_info__ first also populates __version__.
- installed-copy path (no .git) works: _version.py 3.5.0.dev1324 -> (3,5,0,'alpha',1324).
- pytest lib/matplotlib/tests/test_matplotlib.py -> 3 passed, 1 skipped.
- pytest lib/matplotlib/tests/test_api.py -> 9 passed. flake8 clean.
- PRE-EXISTING failures (identical on stashed/unmodified tree): test_cbook.py 18 failed,
  test_backend_svg.py::test_noscale[pdf] 1 failed.
