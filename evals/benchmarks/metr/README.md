# metr — planned

Agentic task batteries in the METR style: longer-horizon tasks where the
measurement is "how far can the agent get before it fails", not a single
pass/fail patch. The complement to swe-bench's single-shot tasks — it's where
durability features (resumable runs, notes, revival) show up as numbers
instead of anecdotes.

**Status: planned — nothing is wired yet.** When adopted:

- `data/` — the task definitions (or a fetch script pinning versions)
- an anchor arm over the task's environment, with the run's checkpoints and
  thread store wired in (this benchmark should exercise resumption honestly)
- a grader adapter that records partial progress, not just end state
- `results/` — the score curve for each round

Keep this folder documentation-first until the source is pinned: an empty
integration that lies about task provenance is worse than no benchmark.
