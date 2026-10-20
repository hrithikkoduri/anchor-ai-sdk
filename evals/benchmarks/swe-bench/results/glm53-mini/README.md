# GLM 5.3 (mini-swe-agent): SWE-bench Lite-10

Nine of ten tasks resolved; one produced no patch.

| | |
|---|---|
| arm | `mini-swe-agent` (its own loop, 250 steps, `$3`) |
| model | `zai-org/GLM-5.3` |
| provider | Parasail, `temperature 0`, `seed 42` |
| benchmark | SWE-bench Lite (`swebench-lite-10.jsonl`) |
| resolved | **9 / 10** |
| empty patch | `matplotlib__matplotlib-18869` |
| grading | official `swebench.harness` |

## What is here

```
verdicts.jsonl   one line per task: verdict
results.jsonl    steps, status, patch size, wall time
manifest.json    the table above, plus each patch's sha1
patches/         the patch that was graded (<task>.diff)
grading/         the harness report for the run
run.json         the run's own record
```

There are no traces: mini runs its own loop, so it emits none of the engine's
events.

## The empty patch

`matplotlib-18869` did not fail on a test. Mini's own `git commit` left an
`index.lock` in the worktree, and the runner's patch extraction then failed,
so the task was recorded with a 0-byte patch. The sandbox was otherwise
healthy and the task was the only one affected.
