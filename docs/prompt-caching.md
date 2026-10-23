# Prompt caching

Prompt caching lets a provider reuse the computed prefix of a prompt instead of
re-running prefill for it on every call. It is most useful for agent loops,
where the system prompt, tool schemas, and earlier conversation are resent on
every step.

## What a breakpoint is

A cache breakpoint is a marker at the end of a stable prefix:

```text
[ system prompt + tools + conversation prefix ][ dynamic turn state ][ new request ]
                                              ^
                                        cache breakpoint
```

Everything up to the marker can be cached. A later request must match that
prefix exactly to get a hit. Changing text before the marker invalidates the
cache from that point onward; changing text after it does not invalidate the
stable prefix.

Anthropic-style providers use a content marker such as:

```json
{ "type": "text", "text": "...", "cache_control": { "type": "ephemeral" } }
```

OpenAI and some gateways cache automatically and do not need explicit markers.
Some providers reject unknown `cache_control` fields, so Anchor makes this
opt-in.

## Enable it

```ts
import { createLLMClient } from "anchor-ai-sdk";

const llm = createLLMClient({
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_KEY,
  model: "anthropic/claude-sonnet-4",
  promptCache: { ttl: "5m" }, // or true, or { ttl: "1h" }
});
```

`llmFromCatalog({ ..., promptCache: true })` also passes the option through. The
engine marks two places automatically:

1. the stable system prompt;
2. the last stable message before the turn-scoped ledger/phase/handoff block.

It never marks the changing turn state. The adapter emits `cache_control` only
when `promptCache` is enabled.

For a custom client or a provider-specific extension, `LLMRequest` also accepts
low-level `cacheBreakpoints` as 0-based message indexes.

## Why it lowers cost

Providers usually bill cache reads at a fraction of normal input-token prices,
and may charge a premium for writing the cache. The benefit grows when a long,
identical prefix is reused many times.

The client already reports cache usage in `usage.cachedTokens` and, when pricing
is configured, bills cached tokens at `priceCacheReadPerMTok` (or the catalog's
`input_cache_read` rate). The exact economics are provider-specific.

## Why it lowers latency

Cached prefix tokens do not need to be prefetched/computed again, so
time-to-first-token drops. Generation time after the first token is unchanged.
The effect is largest with a long system prompt, many tools, or a long stable
history; it is negligible for short prompts.

## Practical rules

- Put stable content first: system prompt, tool schemas, repository context.
- Keep dynamic content last: ledger changes, phase, current observations.
- Reuse the same prefix for the cache to hit; a small edit before the marker
  invalidates it.
- Respect provider minimums and TTL. Providers often require a minimum cacheable
  prefix and expire entries after minutes; a write that is never read can cost
  more than it saves.
- Do not enable explicit markers on a provider that expects automatic caching
  or rejects unknown fields.
- Verify with provider usage: `cachedTokens` should become non-zero on repeated
  calls. A zero value means the prefix did not match, the minimum was not met,
  or the provider ignored the markers.

## Related code

- `src/llm/openai-compatible.ts` — wire markers and usage accounting.
- `src/engine/prompt.ts` — stable/turn prompt block contract.
- `src/engine/loop.ts` — stable-prefix breakpoint selection.
