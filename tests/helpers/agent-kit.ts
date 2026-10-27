/**
 * Shared fixtures for engine-level unit tests: a scripted LLM that records
 * every request, the minimal `test` agent with a read-only probe, and the
 * `create_task` call most ledger tests open with.
 */
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";
import { defineTool } from "../../src/tools/types.js";
import type { Agent } from "../../src/agents/types.js";

// The engine entry points every engine test drives, re-exported so a test
// file needs one import for the kit and the loop.
export { runAgent, userTurn } from "../../src/engine/loop.js";

export function response(
  text: string,
  toolCalls: LLMResponse["toolCalls"] = [],
): LLMResponse {
  return {
    text,
    toolCalls,
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    model: "fake",
    latencyMs: 1,
  };
}

export function agentLlm(sequence: LLMResponse[]): LLMClient & {
  seen: LLMRequest[];
} {
  let index = 0;
  const seen: LLMRequest[] = [];
  return {
    model: "fake",
    seen,
    complete: async (req) => {
      seen.push(structuredClone(req));
      throw new Error("unexpected complete call");
    },
    stream: async (req, onDelta) => {
      seen.push(structuredClone(req));
      const item = sequence[index];
      if (!item) throw new Error(`unexpected model call ${index + 1}`);
      index += 1;
      onDelta(item.text);
      return item;
    },
  };
}

export const probe = defineTool(
  {
    name: "probe",
    description: "look at the auth code",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  async () => ({ ok: true, content: "refresh happens in src/auth/session.ts:42" }),
  { readOnly: true },
);

export const testAgent: Agent = {
  name: "test",
  strategy: {
    name: "test",
    phases: [
      { id: "understand", goal: "establish the request" },
      { id: "act", goal: "do the requested work" },
      { id: "validate", goal: "verify the work" },
    ],
    systemPrompt: () => "test agent",
  },
  tools: [probe],
};

export const createTask = (opts: {
  phase?: string;
  required?: boolean;
} = {}) => ({
  id: "create",
  name: "create_task",
  arguments: JSON.stringify({
    goal: "Investigate where auth is refreshed",
    requirements: [
      {
        text: "Find the refresh path",
        required: opts.required ?? true,
        phase: opts.phase ?? "understand",
      },
    ],
  }),
});
