# Task: pairplot fails when hue_order is a subset of hue values (seaborn 0.11.1 regression)

## Environment
- /opt/miniconda3/envs/testbed/bin/python: pandas 2.0.0, numpy 1.25.2, mpl 3.7.2, seaborn 0.12.0.dev0 (editable /testbed)
- base commit 94621cef (worktree clean at start)

## Verified facts
- Repro `sns.pairplot(iris, hue="species", hue_order=["setosa","versicolor"])` fails.
  BUT the first traceback in this env is pandas OptionError 'mode.use_inf_as_null'
  (pandas 2.0 removed that option) from seaborn/_oldcore.py:1096 -> this masks the real bug.
- Baseline test run `tests/test_axisgrid.py`: 50 failed, 65 passed; most failures are
  OptionError/AttributeError due to pandas 2.0 vs this old seaborn revision.
  => must distinguish pre-existing env failures from the target failure.

## Next steps
- [ ] Identify the true hue_order-subset failure once pandas option error is worked around
      (monkeypatch pd.option_context in repro script).
- [ ] Find upstream fix for GH# issue "pairplot fails with hue_order not containing all hue values".
- [ ] Fix source, add no test edits, verify with relevant test files.
