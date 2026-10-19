/**
 * Budget revival — the package half: the near-limit warning, the
 * `request_revival` handoff tool, and the request riding the result when the
 * budget wins. Funding a revival run is the consumer's decision, so nothing
 * here grants anything.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandbox } from "../../src/sandbox/local/index.js";
import { codingAgent } from "../../src/agents/coding/index.js";
import { runAgent } from "../../src/engine/loop.js";
import type { AgentEvent } from "../../src/engine/events.js";
import type { LLMClient, LLMRequest } from "../../src/llm/types.js";

type Turn = {
  text?: string;
  calls?: Array<{ name: string; arguments?: string }>;
  /** Per-turn usage overrides — e.g. costUsd to make dollar caps bind. */
  usage?: Partial<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
  }>;
};

/** A minimal scripted client that records every wire request. */
function scripted(turns: Turn[]) {
  const seen: LLMRequest[] = [];
  const next = (): unknown => {
    const turn = turns.shift();
    if (!turn) throw new Error("scripted LLM ran out of responses");
    return {
      text: turn.text ?? "",
      toolCalls: (turn.calls ?? []).map((call, index) => ({
        id: `call_${index}_${seen.length}`,
        name: call.name,
        arguments: call.arguments ?? "{}",
      })),
      usage: {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        ...(turn.usage ?? {}),
      },
      model: "scripted",
      finishReason: "stop",
      latencyMs: 1,
    };
  };
  return {
    seen,
    model: "scripted",
    complete: async (request: LLMRequest) => {
      seen.push(structuredClone(request));
      return next();
    },
    stream: async (request: LLMRequest) => {
      seen.push(structuredClone(request));
      return next();
    },
  } as unknown as LLMClient & { seen: LLMRequest[] };
}

let sandbox: LocalSandbox;

beforeEach(async () => {
  sandbox = new LocalSandbox({}, { quiet: true });
  await sandbox.start();
});

afterEach(async () => {
  await sandbox.destroy();
});

const echo = (index: number) => ({
  name: "bash",
  arguments: JSON.stringify({ command: `echo step ${index}` }),
});

describe("budget revival", () => {
  it("warns once, records the request, and carries it when the budget wins", async () => {
    // 110 tokens per call; max 1000 → the 85% warning fires before call 9.
    const llm = scripted([
      ...Array.from({ length: 8 }, (_, index) => ({ calls: [echo(index)] })),
      {
        calls: [
          {
            name: "request_revival",
            arguments: JSON.stringify({
              remaining: "finish the parser fix and run the suite",
              estimatedSteps: 6,
              estimatedTokens: 5000,
            }),
          },
        ],
      },
      { calls: [echo(9)] },
      { calls: [echo(10)] },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent(
      { task: "Fix the parser." },
      {
        llm,
        sandbox,
        agent: codingAgent,
        budgets: { maxTokens: 1000, maxSteps: 100 },
        revival: {},
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.reason).toBe("budget_exceeded");
    expect(result.revival).toEqual({
      remaining: "finish the parser fix and run the suite",
      estimatedSteps: 6,
      estimatedTokens: 5000,
    });
    expect(
      events.some(
        (event) => event.type === "advisory" && event.kind === "budget_warning",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "revival_requested")).toBe(
      true,
    );

    // The system prompt explains the deal; the warning reaches the model on
    // the turn after the 85% line.
    const first = JSON.stringify(llm.seen[0]);
    expect(first).toContain("Budget and revival");
    expect(first).toContain("request_revival");
    const warned = llm.seen[8]!;
    expect(JSON.stringify(warned.messages)).toContain("Budget warning:");
  });

  it("warns on dollars when the price makes them bind first", async () => {
    // $2.50 a call against a $20 cap: 85% is $17, crossed by call 7 — the
    // old tokens/steps-only warning would have stayed silent until death.
    const cost = { costUsd: 2.5 };
    const llm = scripted([
      ...Array.from({ length: 7 }, (_, index) => ({
        calls: [echo(index)],
        usage: cost,
      })),
      {
        calls: [
          {
            name: "request_revival",
            arguments: JSON.stringify({
              remaining: "finish under the dollar cap",
            }),
          },
        ],
        usage: cost,
      },
      { calls: [echo(9)], usage: cost },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent(
      { task: "Fix the parser." },
      {
        llm,
        sandbox,
        agent: codingAgent,
        budgets: { maxUsd: 20, maxTokens: 1_000_000_000, maxSteps: 500 },
        revival: {},
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.reason).toBe("budget_exceeded");
    expect(result.revival?.remaining).toBe("finish under the dollar cap");
    const warning = events.find(
      (event): event is Extract<AgentEvent, { type: "advisory" }> =>
        event.type === "advisory" && event.kind === "budget_warning",
    );
    expect(warning?.detail).toContain("$17.50/$20");
    // The warning reached the model on the turn after $17.50 was spent.
    const warned = llm.seen[7]!;
    expect(JSON.stringify(warned.messages)).toContain("Budget warning");
    expect(JSON.stringify(warned.messages)).toContain("$17.50/$20");
  });

  it("is fully off unless the consumer opts in", async () => {
    const llm = scripted(
      Array.from({ length: 12 }, (_, index) => ({ calls: [echo(index)] })),
    );
    const events: AgentEvent[] = [];
    const result = await runAgent(
      { task: "Fix the parser." },
      {
        llm,
        sandbox,
        agent: codingAgent,
        budgets: { maxTokens: 1000, maxSteps: 100 },
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.reason).toBe("budget_exceeded");
    expect(result.revival).toBeUndefined();
    expect(
      events.some(
        (event) => event.type === "advisory" && event.kind === "budget_warning",
      ),
    ).toBe(false);
    const first = JSON.stringify(llm.seen[0]);
    expect(first).not.toContain("request_revival");
    expect(first).not.toContain("Budget and revival");
  });
});
