# GLM 5.3: SWE-bench Lite-10

Nine of ten tasks have a harness-verified patch.

| | |
|---|---|
| model | `zai-org/GLM-5.3` |
| provider | Parasail, `temperature 0`, `seed 42` |
| budgets | 120 steps, 25M tokens |
| benchmark | SWE-bench Lite (`swebench-lite-10.jsonl`) |
| resolved | **9 / 10** |
| unresolved | `sympy__sympy-11400` |
| grading | official `swebench.harness` |

## What is here

```
verdicts.jsonl   one line per task: verdict
results.jsonl    steps, tokens, cost, reason, patch size
manifest.json    the table above, plus each patch's sha1
patches/         the patch that was graded (<task>.diff)
traces/          the engine trace for that task (<task>.jsonl)
grading/         the harness report for the run
runs/            the run record as one unit: results, predictions, run.json
```

## Why the one failure fails

- **`sympy-11400`**: the patch adds `_print_sinc`, printing `sinc(x)` as a
  `Piecewise` of `sin(x)/x` and `Ne(x, 0)`. Two hidden tests fail:

  - `test_ccode_sinc`: the expected string prints the relation as
    `(Ne(x, 0))`; without a C relational printer the output does not match.
  - `test_ccode_Relational`: asserts `ccode(Eq(x, y)) == "x == y"`, which this
    repo cannot do until a relational printer exists.

  The upstream fix adds **both** `_print_Relational` and `_print_sinc`; the
  patch adds only the second. The sinc implementation is in the right shape
  but rests on a printer that was never added. The agent also wrote its own
  copy of `test_ccode_sinc` into the repo, so its local test passed while the
  graded ones did not.

  This is a genuine model miss: the failing behavior (the relation printer) is
  the first half of the fix.

## Notable tasks

- **`matplotlib-18869`**: the hidden test wants upstream's
  `_parse_to_version_info` namedtuple; the patch implements exactly that and
  passes. The issue also offers a `version_info` tuple as an alternative, but
  that design does not satisfy the tests.
- **`xarray-3364`**: the patch adds the missing-variable handling in
  `xarray/core/concat.py`; both target tests and all existing concat tests
  pass.
- **`seaborn-2848`**: the patch filters rows whose hue value is not in the
  mapping; the official `test_hue_order` passes.
