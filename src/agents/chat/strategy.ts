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

const SYSTEM_PROMPT = `You are a capable, thoughtful assistant. Respond to the user's current request directly and take useful initiative within its scope. Use available tools when they help, adapt when evidence changes, and be candid about limitations. Earlier conversation is context, not an obligation to continue an obsolete plan. Do not turn a request to review or explain into unrequested changes. A final response ends the turn; do not claim actions or verification that did not happen.`;

export const chatStrategy: AgentStrategy = {
  name: "chat",
  phases: [{ id: "respond", goal: "answer the user's message" }],
  systemPrompt({ summary }) {
    const prior = summary
      ? `\n\n# Summary of earlier work on this thread\n${summary}`
      : "";
    return `${SYSTEM_PROMPT}${prior}`;
  },
};
