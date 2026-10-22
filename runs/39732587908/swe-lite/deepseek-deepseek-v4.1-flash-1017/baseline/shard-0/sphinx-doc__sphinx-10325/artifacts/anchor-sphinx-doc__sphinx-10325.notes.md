# inherited-members multiple classes — DONE

## Verified final state
- `inherited_members_option` returns a set: {'object'} for flag/None, split set for value, set() for empty.
- `is_filtered_inherited_member` normalizes True->{'object'}, str->{str}, falsy->set(), and uses `cls.__name__ in inherited_members`.
- Docs: doc/usage/extensions/autodoc.rst (multi-class example + versionchanged 5.0); CHANGES "Features added" #10302.

## Evidence
- tests/test_ext_autodoc.py, _autoclass, _automodule, _configs, _events, _mock, _autosummary, napoleon(2), test_build_html, test_domain_py: 802 passed / 17 skipped.
- Full tests/: 1740 passed, 9 failed — all 9 reproduce identically on clean stashed checkout (linkcheck x2, needs_sphinx, imgconverter, viewcode, intl x2, theming, util_i18n format_date).
- Live sphinx builds in /tmp: `:inherited-members: Base1,Base3` filters Base1/Base3 while keeping Base2; `list, tuple, set` suppresses stdlib bases; single class and bare flag unchanged.
- test_attrgetter_using fails standalone on clean checkout too (test isolation), passes in file run.
