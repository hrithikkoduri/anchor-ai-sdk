import { describe, expect, it } from "vitest";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from "../../src/llm/types.js";
import {
  compileLedger,
  type PhaseGoal,
} from "../../src/ledger/compiler.js";
import {
  verifyAlignment,
  type AlignmentVerdict,
} from "../../src/ledger/alignment.js";
import { createLedger } from "../../src/ledger/ledger.js";

const phases: PhaseGoal[] = [
  { id: "understand", goal: "Establish the request and relevant facts." },
  { id: "act", goal: "Carry out the requested work." },
  { id: "validate", goal: "Gather evidence that the work is correct." },
  { id: "respond", goal: "Deliver the outcome with evidence." },
];

function response(text: string): LLMResponse {
  return {
    text,
    toolCalls: [],
    usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    model: "test-model",
    latencyMs: 1,
  };
}

function fake(reply: string, capture?: (req: LLMRequest) => void): LLMClient {
  return {
    model: "test-model",
    async complete(req) {
      capture?.(req);
      return response(reply);
    },
    async stream(req, onDelta) {
      const out = response(reply);
      onDelta(out.text);
      return out;
    },
  };
}

describe("compileLedger", () => {
  it("turns a task into grounded requirements", async () => {
    let seen: LLMRequest | undefined;
    const llm = fake(
      JSON.stringify({
        goal: "Fix the redirect method bug.",
        requirements: [
          {
            text: "Preserve GET after a 303 → 307 chain",
            required: true,
            sourceQuote: "redirect method bug",
          },
          {
            text: "Add a regression test",
            required: true,
          },
        ],
      }),
      (req) => {
        seen = req;
      },
    );

    const result = await compileLedger({
      llm,
      taskId: "t1",
      source: "Fix the redirect method bug.",
      phases,
    });

    expect(result.ledger.goal).toBe("Fix the redirect method bug.");
    expect(result.ledger.requirements[0]).toMatchObject({
      id: "r1",
      text: "Preserve GET after a 303 → 307 chain",
      sourceQuote: "redirect method bug",
      origin: "compiled",
      locked: true,
    });
    expect(result.ledger.requirements[1]?.sourceQuote).toBeUndefined();
    expect(result.usage?.totalTokens).toBe(30);
    expect(seen?.responseFormat).toMatchObject({
      type: "json_schema",
      name: "ledger_contract",
    });
  });

  it("drops a quote that is not actually in the task", async () => {
    const llm = fake(
      JSON.stringify({
        goal: "Do the thing",
        requirements: [
          {
            text: "Invented scope",
            required: true,
            sourceQuote: "this is not in the task",
          },
        ],
      }),
    );

    const result = await compileLedger({
      llm,
      taskId: "t1",
      source: "Do the thing",
      phases,
    });
    expect(result.ledger.requirements[0]?.sourceQuote).toBeUndefined();
  });

  it("falls back to the goal as a requirement when extraction is empty", async () => {
    const llm = fake(
      JSON.stringify({ goal: "Investigate auth", requirements: [] }),
    );
    const result = await compileLedger({
      llm,
      taskId: "t1",
      source: "Investigate auth",
      phases,
    });
    expect(result.ledger.requirements).toHaveLength(1);
    expect(result.ledger.requirements[0]).toMatchObject({
      text: "Investigate auth",
      required: true,
      origin: "compiled",
    });
  });
});

describe("verifyAlignment", () => {
  const ledger = createLedger({
    taskId: "t1",
    source: "Fix the redirect bug.",
    requirements: [{ text: "Preserve GET after 303 → 307" }],
  });

  it("returns a structured verdict and includes phase + ledger context", async () => {
    let seen: LLMRequest | undefined;
    const verdict: AlignmentVerdict = {
      allow: true,
      aligned: true,
      justified: true,
      reason: "The implementation goal serves the act phase.",
      requiredAction: "none",
      confidence: 0.9,
    };
    const llm = fake(JSON.stringify(verdict), (req) => {
      seen = req;
    });

    const result = await verifyAlignment({
      llm,
      request: "Fix the redirect bug.",
      phase: phases[1]!,
      ledger,
    });

    expect(result.verdict).toEqual(verdict);
    expect(seen?.responseFormat).toMatchObject({ name: "phase_alignment" });
    expect(String(seen?.messages[1]?.content)).toContain("act:");
    expect(String(seen?.messages[1]?.content)).toContain("Preserve GET");
  });

  it("rejects an invalid requiredAction", async () => {
    const llm = fake(
      JSON.stringify({
        allow: false,
        aligned: false,
        justified: false,
        reason: "no",
        requiredAction: "do_something_else",
        confidence: 0.5,
      }),
    );

    await expect(
      verifyAlignment({
        llm,
        request: "Fix the redirect bug.",
        phase: phases[1]!,
        ledger,
      }),
    ).rejects.toThrow(/requiredAction/);
  });
});
