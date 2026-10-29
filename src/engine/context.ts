/**
 * Message builders — the shapes the OpenAI chat protocol requires.
 *
 * An assistant turn that calls tools must be echoed back with the same
 * tool_calls before tool results can follow; content may be null when the
 * turn was pure tool calls. Keeping these in one place means the loop never
 * hand-rolls protocol details.
 */
import type {
  LLMMessage,
  LLMResponse,
  ReasoningPassback,
} from "../llm/types.js";

/**
 * With `passback` on, the turn keeps its reasoning so the next request in the
 * tool loop can replay it; off, the message is exactly content + tool calls.
 */
export function assistantMessage(
  response: LLMResponse,
  passback: ReasoningPassback = false,
): LLMMessage {
  return {
    role: "assistant",
    content:
      response.text === "" && response.toolCalls.length > 0
        ? null
        : response.text,
    tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    ...(passback && response.reasoning
      ? { reasoning: response.reasoning }
      : {}),
    ...(passback && response.reasoningDetails?.length
      ? { reasoningDetails: response.reasoningDetails }
      : {}),
  };
}

export function toolResultMessage(
  toolCallId: string,
  content: string,
): LLMMessage {
  return { role: "tool", tool_call_id: toolCallId, content };
}

export function userMessage(
  content: string,
  images?: LLMMessage["images"],
): LLMMessage {
  return {
    role: "user",
    content,
    ...(images && images.length ? { images } : {}),
  };
}

/** Working memory contains real conversation and observations, not system
 * prompts or internal orchestration messages. No prefix guessing: a user's
 * text is still their text even if it happens to start with "PHASE:".
 * Replayed reasoning is in-run state: it is only needed within the tool loop
 * that produced it, so it is neither persisted nor revived. */
export function conversationHistory(messages: LLMMessage[]): LLMMessage[] {
  return messages
    .filter(
      (message) => message.role !== "system" && message.origin !== "engine",
    )
    .map(withoutReasoning);
}

function withoutReasoning(message: LLMMessage): LLMMessage {
  if (message.reasoning === undefined && message.reasoningDetails === undefined)
    return message;
  const { reasoning: _reasoning, reasoningDetails: _details, ...rest } = message;
  return rest;
}
