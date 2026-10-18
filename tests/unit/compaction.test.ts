/**
 * Compaction tests — the pure pieces (estimate + protocol-safe cut).
 * The end-to-end trigger lives in engine.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  compactionForContextWindow,
  compactConversation,
  estimateTokens,
  findCompactionCut,
} from "../../src/engine/compaction.js";
import type { LLMClient, LLMMessage } from "../../src/llm/types.js";

const msg = (role: LLMMessage["role"], content: string): LLMMessage => ({
  role,
  content,
});
const assistantCall = (text: string, command: string): LLMMessage => ({
  role: "assistant",
  content: text,
  tool_calls: [
    { id: "c1", name: "bash", arguments: JSON.stringify({ command }) },
  ],
});
const toolResult = (content: string): LLMMessage => ({
  role: "tool",
  tool_call_id: "c1",
  content,
});

describe("estimateTokens", () => {
  it("counts content and tool-call arguments at chars/4", () => {
    const messages: LLMMessage[] = [
      msg("user", "abcdefgh"), // 8 chars
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "x", name: "bash", arguments: "12345678" }], // 4 + 8 chars
      },
    ];
    expect(estimateTokens(messages)).toBe(Math.ceil((8 + 4 + 8) / 4));
  });
});

describe("findCompactionCut", () => {
  it("returns -1 when the tail alone fills the keep-budget", () => {
    const messages = [
      msg("system", "s"),
      msg("user", "u"),
      msg("assistant", "a"),
    ];
    expect(findCompactionCut(messages, 100_000)).toBe(-1);
  });

  it("never lets the kept span start with a tool result — slides to the next boundary", () => {
    const big = "x".repeat(400); // ~100 estimated tokens each
    const messages: LLMMessage[] = [
      msg("system", "s"),
      msg("user", "Begin"),
      assistantCall(big, "echo 1"),
      toolResult(big),
      assistantCall(big, "echo 2"),
      toolResult(big), // walk-back stops here (~100 ≥ keep 110 only after including it)
      msg("assistant", big), // plain assistant: the valid boundary after sliding
    ];
    const cut = findCompactionCut(messages, 110);
    expect(cut).toBe(6);
    expect(messages[cut]!.role).not.toBe("tool");
  });

  it("returns -1 when sliding past the end leaves nothing to keep", () => {
    const bigTool = "y".repeat(500); // 125 est ≥ keep 110 → cut lands on the tool itself
    const messages: LLMMessage[] = [
      msg("system", "s"),
      msg("user", "Begin"),
      assistantCall("ok", "echo 1"),
      toolResult(bigTool),
    ];
    expect(findCompactionCut(messages, 110)).toBe(-1);
  });

  it("keeps at least the system prompt plus one summarizable message", () => {
    const big = "x".repeat(4000);
    const messages: LLMMessage[] = [
      msg("system", "s"),
      msg("user", big),
      msg("assistant", big),
    ];
    expect(findCompactionCut(messages, 1100)).toBe(-1);
  });
});

describe("compacted outcome", () => {
  it("folds to a summary and a bounded preview of the folded transcript", async () => {
    const messages: LLMMessage[] = [
      msg("system", "s"),
      msg("assistant", "x".repeat(30_000)), // the foldable middle
      msg("user", "tail request"),
    ];
    const llm = {
      model: "t",
      complete: async () => ({
        text: "SUMMARY OF EARLIER WORK",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "t",
        latencyMs: 1,
      }),
      stream: async () => {
        throw new Error("unused");
      },
    } as unknown as LLMClient;
    const outcome = await compactConversation({
      llm,
      messages,
      keepRecentTokens: 1,
    });
    expect(outcome!.summary).toBe("SUMMARY OF EARLIER WORK");
    expect(outcome!.foldingPreview).toContain("truncated for the record");
    expect(outcome!.foldingPreview.length).toBeLessThan(6_300);
  });

  it("derives fold budgets from the model window — capped to the working range, floored for tiny windows", () => {
    // A 1M-window model folds at the 300k ceiling, keeping the recent quarter.
    expect(compactionForContextWindow(1_048_576)).toEqual({
      maxEstimatedTokens: 300_000,
      keepRecentTokens: 75_000,
    });
    // A 128k model scales down instead of silently overrunning its window.
    expect(compactionForContextWindow(131_072)).toEqual({
      maxEstimatedTokens: 72_090,
      keepRecentTokens: 18_022,
    });
    // A tiny window stays proportionally below itself (70% cap on the floor).
    expect(compactionForContextWindow(32_768)).toEqual({
      maxEstimatedTokens: 22_938,
      keepRecentTokens: 5_734,
    });
  });
});
