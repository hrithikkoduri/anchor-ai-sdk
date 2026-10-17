/**
 * Message builders — the shapes the OpenAI chat protocol requires.
 *
 * An assistant turn that calls tools must be echoed back with the same
 * tool_calls before tool results can follow; content may be null when the
 * turn was pure tool calls. Keeping these in one place means the loop never
 * hand-rolls protocol details.
 */
import type { LLMMessage, LLMResponse } from "../llm/types.js";

export function assistantMessage(response: LLMResponse): LLMMessage {
  return {
    role: "assistant",
    content: response.text === "" && response.toolCalls.length > 0 ? null : response.text,
    tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
  };
}

export function toolResultMessage(toolCallId: string, content: string): LLMMessage {
  return { role: "tool", tool_call_id: toolCallId, content };
}

export function userMessage(content: string): LLMMessage {
  return { role: "user", content };
}
