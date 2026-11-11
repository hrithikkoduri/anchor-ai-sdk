# Reasoning and tool-call guardrails

Reasoning models can spend the whole output cap on hidden reasoning and return
nothing. Some providers also pass a model's own call syntax through as plain
text instead of a structured tool call. Anchor treats both as turn conditions,
not as a final answer.

## Reasoning effort

`reasoningEffort` is a per-run or per-agent setting:

```ts
await runAgent(
  { messages: [{ role: "user", content: "Fix the retry bug" }] },
  { llm, agent, reasoningEffort: "high" },
);
```

`EngineOptions.reasoningEffort` wins over an agent bundle's default. The
OpenAI-compatible client sends it in the provider's native shape:

- OpenRouter: `reasoning: { effort }`
- OpenAI: `reasoning_effort`

The accepted values are `minimal`, `low`, `medium`, `high`, and `xhigh`.

## Reasoning-only turn

A turn is reasoning-only when it has:

- empty text;
- no tool calls;
- `finishReason` of `length`, or reasoning/completion tokens at the cap.

The engine continues the same thread up to three times with:

- a reasoning-limit nudge;
- `tool_choice: "required"` when the client declares support;
- reasoning effort capped at `low`;
- an 8k output budget.

If the third forced continuation still returns nothing, the run pauses with
`retryable: true`. The thread is intact; the consumer can retry the run without
treating the thread as stopped.

Capped prose and ordinary empty-turn behaviour are unchanged.

## Leaked tool call

Some providers emit a tool call as text:

```text
<｜DSML｜ calls>
<｜DSML｜ invoke name="ask_questions">
...
```

The call was never structured, so no tool ran. The engine detects the markers
for DeepSeek DSML and its earlier call tokens, and Hermes/Qwen `<tool_call>`
JSON. It asks for a real call, up to twice, then stalls with an error. It does
not parse the text into a call.

Plain prose about tools is untouched. A code sample that mentions
`<tool_call>` is also untouched.

## Client support

`LLMRequest.toolChoice` is `"auto" | "required" | "none"`. The engine only sends
`required` when the client declares `supportsToolChoice: true`; a gateway whose
upstream rejects `tool_choice` leaves it unset.

```ts
const llm = openAICompatible({
  baseUrl,
  apiKey,
  model,
  supportsToolChoice: true,
});
```

The engine's own reasoning continuation is a bounded retry, not a guarantee that
the model will answer. A provider that cannot emit a structured call is not
fixed by the engine.

## Events

| Event | Meaning |
| --- | --- |
| `advisory` with `kind: "reasoning_limit"` | The run hit a reasoning-only turn and asked for an action. |
| `advisory` with `kind: "leaked_tool_call"` | The reply carried call markup as text and was corrected. |
| `advisory` with `kind: "empty_turn"` | The ordinary empty-turn correction. |

The `finish` result is `stalled` for a repeated leaked call, or `retryable`
for a reasoning-only run that exhausted its continuations.

## Limits

- The continuation is bounded; a model that keeps reasoning without acting will
  still pause.
- The leaked-call check is a course correction, not a parser. A call written as
  text is never executed.
- The reasoning-limit retry is a policy in the engine. A consumer can still
  choose to retry the paused run or leave it.
- A provider that ignores `tool_choice` cannot be forced into a call.

## Tests

- `tests/unit/reasoning-limit.test.ts`
- `tests/unit/leaked-tool-call.test.ts`
- `tests/unit/agent-loop.test.ts`
