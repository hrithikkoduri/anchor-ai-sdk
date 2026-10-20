# GLM 5.3: SWE-bench Lite-10, consolidated

Nine of ten tasks have a harness-verified patch. This folder is a **stitch** of
three runs, not one clean sweep: each task's files come from the latest run
that resolved it. Read the per-task `source_run` before quoting a score.

| | |
|---|---|
| model | `z-ai/glm-5.3` (OpenRouter) / `zai-org/GLM-5.3` (Parasail) |
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
grading/         ONE report for the 9/10 result, with per-instance test status
runs/            the run record as one unit: results, predictions, run.json
```

This folder is the durable record. `.eval-runs/` is local scratch and can be
pruned; the four older runs were moved to `.eval-runs/_archive/` and are safe
to delete, since everything in them that matters is copied here.

## The run

Parasail, 120 steps, 25M tokens, `temperature 0` / `seed 42`.

The earlier OpenRouter rounds (6–8/10) stay in this benchmark's
`verdicts.jsonl` and `comparison.md` as the Round 1 context, and are not part
of this folder's score.

`grading/glm-5.3-parasail.json` is the harness report for this result: the
9/10 counts, the id lists, and `instances`: each task with its own
FAIL_TO_PASS/PASS_TO_PASS status.

Four of these tasks were re-run once, because the budgets were set before
mini's configuration was known: the first pass named 1.5M/3M-token ceilings
that nothing else used. With the budgets settled, the four were re-run and
this folder records the outcome as one result. `seaborn` and `xarray` passed
there because the engine now course-corrects an identical tool call and a
capped reply instead of ending the run; `matplotlib` passed for a different
reason (see below).

## Why the four failures behaved as they did

- **`matplotlib-18869`**: the issue admits two designs. The parasail run built
  `matplotlib.version_info` (a tuple, which the issue calls "much more
  common"); the hidden test wants upstream's `_parse_to_version_info`. The
  re-run passed by implementing the upstream shape. Not an engine defect;
  r2 passed it by fetching the upstream PR from GitHub.
- **`xarray-3364`**: the parasail run stalled at step 26 on three identical
  no-op edits, so its patch was unfinished and broke two existing tests. The
  re-run finished and passed.
- **`seaborn-2848`**: the parasail run hit the 3M token cap with a patch
  already on disk. At 25M it ran the full 120 steps and the patch it left
  passed. A later 250-step attempt errored at step 116 on a Parasail
  `429 Endpoint Busy`, so this folder carries the 120-step patch.
- **`sympy-11400`**: see below. Still unresolved.

## Why sympy still fails

The patch adds `_print_sinc`, printing `sinc(x)` as a `Piecewise` of
`sin(x)/x` and `Ne(x, 0)`. Two hidden tests fail:

- `test_ccode_sinc`: the expected string prints the relation as
  `(Ne(x, 0))`; without a C relational printer the output does not match.
- `test_ccode_Relational`: asserts `ccode(Eq(x, y)) == "x == y"`, which this
  repo cannot do until a relational printer exists.

The upstream fix adds **both** `_print_Relational` and `_print_sinc`; the
patch adds only the second. So the sinc implementation is in the right shape
but rests on a printer that was never added. It also wrote its own copy of
`test_ccode_sinc` into the repo, so its local test passed while the graded
ones did not.

This is a genuine model miss, not a harness artifact: the failing behavior
(the relation printer) is the first half of the fix.
