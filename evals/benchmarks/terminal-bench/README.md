# terminal-bench 2.1

Ten tasks from the public Terminal-Bench 2.1 dataset, kept as Harbor task
directories (`task.toml`, `instruction.md`, `tests/`). The agent gets a shell
in the official task container; the task's own verifier grades the final state.

- Data: `data/tasks/<task>/`, manifest `data/tasks.jsonl`.
- Images: the task's `environment.docker_image` (pulled at run time).
- Grading: in-place, `bash /tests/test.sh`; reward comes from
  `/logs/verifier/reward.txt`.
- Fetch/update: `node scripts/fetch-harbor-tasks.mjs`.
- Run: `BENCH=terminal-bench MODEL=openai/gpt-5.3-codex bash scripts/run-bench.sh`

The ten tasks are a stratified first slice, not the full 89-task suite.
