import { readFileTool, searchTool, runAgent } from "anchor-ai-sdk";

export const phases = [
  { id: "inspect", goal: "Read the relevant code." },
  { id: "respond", goal: "Explain findings with file references." },
];

export const strategy = {
  name: "review",
  phases,
  requiresSandbox: true,
  systemPrompt: () => phases
    .map(({ id, goal }) => `${id}: ${goal}`).join("\n"),
};

export const agent = {
  name: "reviewer", strategy,
  tools: [searchTool, readFileTool],
};

// Supply your llm and a started sandbox. Full setup is in the docs.
const result = await runAgent(
  { task: "Explain the retry behavior" },
  { llm, sandbox, agent },
);
