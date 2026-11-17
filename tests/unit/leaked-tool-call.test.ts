import { describe, expect, it } from "vitest";
import { leakedToolCall } from "../../src/engine/guardrails.js";

describe("a tool call written as text", () => {
  it("is recognised by each model family's own call delimiters", () => {
    expect(leakedToolCall('<｜DSML｜ calls>\n<｜DSML｜ invoke name="ask_questions">')).toBe(true);
    expect(leakedToolCall('text <｜DSML｜ invoke name="x"> more')).toBe(true);
    expect(leakedToolCall("<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function")).toBe(true);
    expect(leakedToolCall('<tool_call>\n{"name": "read", "arguments": {}}\n</tool_call>')).toBe(true);
  });

  it("is not a reply that only talks about tools or uses angle brackets", () => {
    expect(leakedToolCall("I will call the ask_questions tool next.")).toBe(false);
    expect(leakedToolCall("Use `<tool_call>` tags only inside code samples.")).toBe(false);
    expect(leakedToolCall("The type is Array<Record<string, unknown>> and x < y.")).toBe(false);
  });
});
