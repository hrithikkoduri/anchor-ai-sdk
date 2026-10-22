# pairplot hue_order subset (seaborn issue GH2860)

## Facts
- env: pandas 2.0.0, mpl 3.7.2, numpy 1.25.2 in /opt/miniconda3/envs/testbed
- repo has many pre-existing env failures: `mode.use_inf_as_null` gone in pandas 2.0
  (seaborn/_oldcore.py:1096, categorical.py:1845, _core/plot.py). Also `df.iteritems`.
- Repro: pairplot(iris, hue="species", hue_order=["setosa","versicolor"]) fails;
  currently fails first at pd.option_context('mode.use_inf_as_null') in comp_data for
  the *unfiltered* plot, i.e. env issue masks the real bug.
- existing tests: tests/test_axisgrid.py TestPairGrid::test_hue_order_missing_level (line 1130)
  and test_hue_order.

## Next
- Find code path in axisgrid PairGrid where hue levels not in hue_order are handled.
- Determine if base commit already includes partial fix; check git show a110ef5.
- Reproduce real bug by patching env issue locally (not committed), then fix source.
