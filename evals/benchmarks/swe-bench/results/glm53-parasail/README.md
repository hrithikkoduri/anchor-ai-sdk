# GLM 5.3 — SWE-bench Lite-10, consolidated

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
verdicts.jsonl   one line per task: verdict + the run it came from
results.jsonl    steps, tokens, cost, reason, patch size — same shape as a run
manifest.json    the table above, plus each patch's sha1
patches/         the patch that was graded (<task>.diff)
traces/          that run's engine trace (<task>.jsonl)
grading/         the harness report per source run (Parasail only)
runs/<run>/      every run's own results.jsonl, predictions.jsonl, run.json
```

This folder is the durable record. `.eval-runs/` is local scratch and can be
pruned; the four older runs were moved to `.eval-runs/_archive/` and are safe
to delete, since everything in them that matters is copied here.

## The runs

| run | provider / budgets | resolved |
|---|---|---|
| `glm-5.3-parasail` | Parasail, 120 steps, 25M tok | 6/10 |
| `retry-parasail` | Parasail, 120 steps, 25M tok, new engine (#79) | 3/4 |

Only Parasail runs live here. The earlier OpenRouter rounds (6–8/10) stay in
this benchmark's `verdicts.jsonl` and `comparison.md` as the Round 1 context,
and are not part of this folder's score.

The retry re-ran only the four tasks the Parasail run failed. `seaborn` and
`xarray` passed there because the engine now course-corrects an identical
tool call and a capped reply instead of ending the run; `matplotlib` passed
for a different reason (see below).

## Why the four failures behaved as they did

- **`matplotlib-18869`** — the issue admits two designs. The parasail run built
  `matplotlib.version_info` (a tuple, which the issue calls "much more
  common"); the hidden test wants upstream's `_parse_to_version_info`. The
  retry passed by implementing the upstream shape. Not an engine defect —
  r2 passed it by fetching the upstream PR from GitHub.
- **`xarray-3364`** — the parasail run stalled at step 26 on three identical
  no-op edits, so its patch was unfinished and broke two existing tests. The
  retry finished and passed.
- **`seaborn-2848`** — the parasail run hit the 3M token cap with a patch
  already on disk. At 25M it ran the full 120 steps and the patch it left
  passed. A later 250-step attempt errored at step 116 on a Parasail
  `429 Endpoint Busy`, so this folder carries the 120-step patch.
- **`sympy-11400`** — see below. Still unresolved.

## Why sympy still fails

The patch adds `_print_sinc`, printing `sinc(x)` as a `Piecewise` of
`sin(x)/x` and `Ne(x, 0)`. Two hidden tests fail:

- `test_ccode_sinc` — the expected string prints the relation as
  `(Ne(x, 0))`; without a C relational printer the output does not match.
- `test_ccode_Relational` — asserts `ccode(Eq(x, y)) == "x == y"`, which this
  repo cannot do until a relational printer exists.

The upstream fix adds **both** `_print_Relational` and `_print_sinc`; the
patch adds only the second. So the sinc implementation is in the right shape
but rests on a printer that was never added. It also wrote its own copy of
`test_ccode_sinc` into the repo, so its local test passed while the graded
ones did not.

This is a genuine model miss, not a harness artifact: the failing behavior
(the relation printer) is the first half of the fix.
