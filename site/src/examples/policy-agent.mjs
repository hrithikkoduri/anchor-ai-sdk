import { pathToFileURL } from "node:url";
import {
  defineTool,
  requireString,
  llmFromCatalog,
  runAgent,
} from "anchor-ai-sdk";

// 01 / TOOL
// Demo data only. Replace this with your authorized data service.
const policies = new Map([
  [
    "refunds",
    "Refunds are available within 30 days with the original receipt.",
  ],
  ["shipping", "Standard shipping takes 3–5 business days."],
]);

export const lookupPolicy = defineTool(
  {
    name: "lookup_policy",
    description: "Look up a demo store policy: refunds or shipping.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  async (input) => {
    const topic = requireString(input, "topic").trim().toLowerCase();
    const policy = policies.get(topic);
    return {
      ok: policy !== undefined,
      content: policy ?? "No policy found. Do not invent one.",
      meta: { topic, source: "demo-policies" },
    };
  },
  { readOnly: true },
);

// 02 / STRATEGY
export const policyPhases = [
  { id: "lookup", goal: "Find the relevant policy with lookup_policy." },
  {
    id: "answer",
    goal: "Give a short answer grounded in the retrieved policy.",
  },
];

// Strategy consumes the phase data; it does not execute a list of steps.
export const policyStrategy = {
  name: "policy",
  phases: policyPhases,
  requiredTools: ["lookup_policy"],
  requiresSandbox: false,
  systemPrompt({ context, summary }) {
    return [
      "You are a store policy assistant working with demo data.",
      "Use lookup_policy before making a claim about store policy.",
      "If the policy is unknown, say so. Never invent terms or exceptions.",
      "Keep the answer short and cite the topic you looked up.",
      ...policyPhases.map((phase) => `${phase.id}: ${phase.goal}`),
      context ? `Authorized application context: ${context}` : "",
      summary ? `Earlier thread context: ${summary}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
};

// 03 / AGENT
// No model or runtime state in the bundle. Reuse it across runs.
export const policyAgent = {
  name: "policy-agent",
  strategy: policyStrategy,
  tools: [lookupPolicy],
};

// 04 / RUN
export async function main() {
  const apiKey = process.env.OPENROUTER_KEY;
  if (!apiKey)
    throw new Error("Set OPENROUTER_KEY before running this example.");

  const { llm, compaction } = await llmFromCatalog({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    model: process.env.MODEL ?? "z-ai/glm-5.3",
  });

  const result = await runAgent(
    { task: "Can I get a refund after 20 days?" },
    {
      llm,
      compaction,
      agent: policyAgent,
      budgets: { maxSteps: 8, maxUsd: 0.25 },
    },
  );
  console.log(result.summary ?? result.error ?? result.reason);
  return result;
}

// Importing the agent does not start a model call. Executing the file does.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
