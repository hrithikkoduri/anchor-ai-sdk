/**
 * The ten-line quickstart, as a runnable file.
 *
 *   OPENROUTER_KEY=... node examples/chat.mjs "explain what an agent harness is"
 *
 * An agent, a model, nothing else: no sandbox, no tools, no product stack.
 * A final text response ends the turn — that IS the reply.
 */
import { chatAgent, llmFromCatalog, runAgent, userTurn } from "anchor-ai-sdk";

const task =
  process.argv.slice(2).join(" ") || "Say hello and name one thing you do.";

const apiKey = process.env.OPENROUTER_KEY;
if (!apiKey) {
  console.error(
    "Set OPENROUTER_KEY (any OpenAI-compatible provider works — adjust baseUrl/model).",
  );
  process.exit(1);
}

const model = process.env.MODEL ?? "z-ai/glm-5.3";
const { llm, catalog } = await llmFromCatalog({
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey,
  model,
});

const result = await runAgent(userTurn(task), { llm, agent: chatAgent });

console.log(`\n${result.summary ?? "(no summary)"}\n`);
console.log(
  [
    `model: ${model}${catalog?.contextLength ? ` (${catalog.contextLength}-token window)` : ""}`,
    `${result.steps} steps`,
    `${result.usage.totalTokens} tokens`,
    ...(result.usage.costUsd !== undefined
      ? [`$${result.usage.costUsd.toFixed(4)}`]
      : []),
    result.reason,
  ].join(" · "),
);
