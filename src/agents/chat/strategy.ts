/**
 * chatStrategy — the zero-config default agent.
 *
 * One phase, no required tools, no sandbox: the model replies, and a
 * text-only turn ends the run (that IS the reply). Tools can still be
 * supplied — the loop keeps going while the model calls them, then finishes
 * when it answers in text.
 *
 * This is what `runAgent({ task }, { llm })` runs when no strategy is given,
 * making the package usable as a plain chat loop with zero plumbing.
 */
import type { AgentStrategy } from "../../engine/strategy.js";

const SYSTEM_PROMPT = `You are a helpful assistant. Answer the user's message directly. If tools are available and helpful, use them, then give your final answer as text.`;

export const chatStrategy: AgentStrategy = {
  name: "chat",
  finishWhenNoToolCalls: true,
  phases: [{ id: "respond", goal: "answer the user's message" }],
  systemPrompt({ task, summary }) {
    const prior = summary ? `\n\n# Summary of earlier work on this thread\n${summary}` : "";
    return `${SYSTEM_PROMPT}${prior}\n\n# The message\n${task}`;
  },
  enterPhaseMessage: (phase) => `PHASE: ${phase.id} — ${phase.goal}.`,
};
