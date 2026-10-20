# Examples

Runnable files: the only dependencies are the package itself and a model key.

```bash
# from the repo root: cp .env.example .env, fill in OPENROUTER_KEY, then
set -a; source .env; set +a

# or export directly: any OpenAI-compatible provider works
export OPENROUTER_KEY=...

# The ten-line quickstart: an agent, a model, nothing else.
node examples/chat.mjs "explain what an agent harness is"

# A NON-coding agent: its own strategy, its own tool, no sandbox.
node examples/repo-triage.mjs README.md
```

`repo-triage.mjs` is the point worth noticing: the strategy, the tool, and the
report are all the consumer's: plain code. Everything the harness provides
still applies (loop, required-tool validation, budgets, trace sinks, the
honest stop). Anchor is an agent harness SDK, not a coding tool.

Both examples resolve `anchor-ai-sdk` through the package's own exports, so
they run straight from a clone of this repo after `npm install`.
