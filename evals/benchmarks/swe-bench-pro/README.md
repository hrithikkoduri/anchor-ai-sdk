# swe-bench-pro (V2)

Ten tasks from ScaleAI's SWE-bench Pro V2, kept as Harbor task directories
(`task.toml`, `instruction.md`, `tests/`). The agent works in the public
task image (`ghcr.io/scaleapi/swe-bench_pro-v2:<instance_id>`); its git diff is
captured and replayed in a pristine container before the unchanged verifier
runs. This is the benchmark's locked protocol.

- Data: `data/tasks/<instance_id>/`, manifest `data/tasks.jsonl`.
- Grading: patch replay, `bash /tests/test.sh`; reward comes from
  `/logs/verifier/reward.txt`.
- Fetch/update: `node scripts/fetch-harbor-tasks.mjs`.
- Run: `BENCH=swe-pro MODEL=openai/gpt-5.3-codex bash scripts/run-bench.sh`

The ten tasks are a language-stratified slice of the 642-task V2 split.
