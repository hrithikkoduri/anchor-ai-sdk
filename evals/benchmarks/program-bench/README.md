# program-bench — planned

Whole-program tasks: build or repair a program that satisfies a behavioral
suite, where the score comes from the program's observable behavior rather
than a diff against a gold patch. The natural third benchmark for a harness
SDK — it exercises the same loop under a different evaluator.

**Status: planned — nothing is wired yet.** Integration shape, when adopted:

- pin the task source (dataset or hand-curated suite) into `data/`
- a task loader producing `EvalTask`s the shared runner already understands
- an anchor arm (likely `codingAgent` with a build/run/verify emphasis —
  no repo clone required, so arms may start from an empty sandbox)
- a grader adapter emitting the standard verdict shape into `.eval-runs`
- the comparison table for this benchmark, next to its `results/`

Nothing here should grow a second runner: if the integration needs one,
that's a signal the shared runner's seam is wrong and should be fixed
instead.
