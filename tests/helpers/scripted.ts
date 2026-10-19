import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";

export type Turn = {
  text?: string;
  tools?: Array<{ name: string; arguments: string }>;
  /** e.g. "length" — a response the provider cut off at the output cap. */
  finishReason?: string;
  /** Override the default tiny usage (10/5/15) — e.g. to simulate a huge turn. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};
export function scripted(queue: Turn[]): LLMClient & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = [];
  const response = (turn: Turn): LLMResponse => ({
    text: turn.text ?? "",
    toolCalls: (turn.tools ?? []).map((tool, i) => ({
      id: `c${seen.length}-${i}`,
      ...tool,
    })),
    usage: turn.usage ?? { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "scripted",
    ...(turn.finishReason !== undefined ? { finishReason: turn.finishReason } : {}),
    latencyMs: 1,
  });
  return {
    seen,
    model: "scripted",
    complete: async (request) => {
      seen.push(structuredClone(request));
      if (request.messages[0]?.content?.includes("compacting an AI agent"))
        return response({ text: "COMPACTED: earlier observations" });
      throw new Error("unexpected complete call");
    },
    stream: async (request, onDelta) => {
      seen.push(structuredClone(request));
      const turn = queue.shift();
      if (!turn) throw new Error("scripted model ran out of turns");
      if (turn.text) onDelta(turn.text);
      return response(turn);
    },
  };
}

export const call = (
  name: string,
  args: Record<string, unknown> = {},
): Turn => ({ tools: [{ name, arguments: JSON.stringify(args) }] });
