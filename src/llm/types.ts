/**
 * The LLM boundary — one interface, one job: take a conversation + tool
 * definitions, return text and/or tool calls plus usage.
 *
 * Everything above (the agent loop) depends only on this; providers are
 * swappable by construction. Messages follow the OpenAI chat format — the
 * de-facto standard that OpenRouter, OpenAI, and most gateways speak.
 */
export interface LLMToolCall {
  /** Provider-assigned id; tool results must reference it. */
  id: string;
  name: string;
  /** Raw JSON string exactly as emitted (the loop validates before use). */
  arguments: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** null is legal for an assistant message that is pure tool calls. */
  content: string | null;
  /** assistant messages only */
  tool_calls?: LLMToolCall[];
  /** tool messages only — which call this result answers */
  tool_call_id?: string;
}

/** OpenAI-style function definition — built from our Tool definitions. */
export interface LLMToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Computed from configured pricing; undefined when pricing is unknown. */
  costUsd?: number;
}

export interface LLMResponse {
  text: string;
  toolCalls: LLMToolCall[];
  usage: LLMUsage;
  model: string;
  finishReason?: string;
  latencyMs: number;
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools?: LLMToolDef[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMClient {
  readonly model: string;
  complete(req: LLMRequest, opts?: { signal?: AbortSignal }): Promise<LLMResponse>;
}
