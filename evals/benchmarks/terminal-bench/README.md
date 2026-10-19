# terminal-bench — planned

The terminal-native sibling of swe-bench: each task ships its own container
and its own grading; the agent gets a shell and has to get the environment
from "as found" to "task solved" — without a repo-shaped scaffold, and often
without a test command handed to it.

**Status: planned — nothing is wired yet.** When it lands, this benchmark
contributes, on the shared runner:

- `tasks.ts` — a loader from the benchmark's task manifests (each task: a
  container image + a problem statement + its own checks)
- an anchor arm — `codingAgent` over the task container, shell-first
  (its `run_tests` step becomes "discover and run the checks")
- a grader adapter — the task's own assertions, mapped to the same
  resolved/unresolved verdict shape swe-bench uses

The shared runner (`../../src/runner.ts`) is already benchmark-agnostic —
tasks → sandbox → arm → diff — so this is a task loader + an arm, not a
second harness. Data and results will live here: `data/`, `results/`.
