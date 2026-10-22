import { describe, expect, it } from "vitest";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";
import {
  completeStructured,
  StructuredOutputError,
} from "../../src/llm/structured.js";

function response(text: string): LLMResponse {
  return {
    text,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "test-model",
    latencyMs: 1,
  };
}

function client(
  reply: (req: LLMRequest) => LLMResponse,
  capture?: (req: LLMRequest) => void,
): LLMClient {
  return {
    model: "test-model",
    async complete(req) {
      capture?.(req);
      return reply(req);
    },
    async stream(req, onDelta) {
      const out = reply(req);
      onDelta(out.text);
      return out;
    },
  };
}

describe("completeStructured", () => {
  it("requests a strict schema and returns the validated value", async () => {
    let seen: LLMRequest | undefined;
    const llm = client(
      () => response('{"allow":true,"reason":"evidence matches"}'),
      (req) => {
        seen = req;
      },
    );

    const result = await completeStructured(llm, {
      name: "verdict",
      schema: {
        type: "object",
        properties: {
          allow: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["allow", "reason"],
        additionalProperties: false,
      },
      messages: [{ role: "user", content: "verify" }],
      parse: (value) => {
        const row = value as { allow?: unknown; reason?: unknown };
        if (typeof row.allow !== "boolean" || typeof row.reason !== "string") {
          throw new Error("bad verdict");
        }
        return { allow: row.allow, reason: row.reason };
      },
    });

    expect(result.value).toEqual({ allow: true, reason: "evidence matches" });
    expect(seen?.responseFormat).toMatchObject({
      type: "json_schema",
      name: "verdict",
      strict: true,
    });
  });

  it("fails loudly on invalid JSON instead of repairing it", async () => {
    const llm = client(() => response("```json\n{}\n```"));

    await expect(
      completeStructured(llm, {
        name: "verdict",
        schema: { type: "object" },
        messages: [{ role: "user", content: "verify" }],
        parse: (value) => value,
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it("fails loudly when the parser rejects the shape", async () => {
    const llm = client(() => response('{"allow":"yes"}'));

    await expect(
      completeStructured(llm, {
        name: "verdict",
        schema: { type: "object" },
        messages: [{ role: "user", content: "verify" }],
        parse: () => {
          throw new Error("allow must be boolean");
        },
      }),
    ).rejects.toThrow(/allow must be boolean/);
  });
});
