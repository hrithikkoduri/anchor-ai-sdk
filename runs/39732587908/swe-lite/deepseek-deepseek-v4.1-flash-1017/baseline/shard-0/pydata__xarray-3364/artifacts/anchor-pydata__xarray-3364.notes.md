# Task: concat should ignore missing variables (issue #508)

## Facts (verified)
- Base 863e4906; upstream fix is exactly commit 4f5ca73c "Make concat more forgiving
  with variables that are being merged. (#3364)" -> closes #508.
- Patch applied = source + whats-new only (test files reverted, graded patch supplies them).
- Reproduced before: "variables {'z'} are present in some datasets but not others" and
  "'a' is not present in all datasets."
- After: both scenarios produce correct datasets (assert_identical OK), incl. the
  upstream test bodies run verbatim from a scratch script.

## Tests
- test_concat.py+test_combine.py+test_merge.py with upstream test patch applied: 133 passed, 1 xfailed.
- Full suite before vs after diff: ONLY new failures are the two stale tests that encode
  the old behavior (test_concat_errors assertion, test_auto_combine_still_fails) which the
  upstream commit rewrites; everything else identical (2146 pre-existing env failures).
- Pre-existing unrelated failures confirmed: cftime tests in test_dataset.py, dask persist.

## Status: DONE
