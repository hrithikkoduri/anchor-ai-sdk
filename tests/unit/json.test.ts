import { describe, expect, it } from "vitest";
import { toPlainJson, toPlainJsonObject } from "../../src/json.js";
import { dispatchToolCalls } from "../../src/engine/dispatch.js";
import { defineTool } from "../../src/tools/types.js";
import { RepeatTracker } from "../../src/engine/guardrails.js";
import { finishTool } from "../../src/tools/finish.js";

describe("toPlainJson", () => {
  it("breaks cycles and names the path", () => {
    const a: Record<string, unknown> = { id: 1 };
    a.self = { back: a };
    const repairs: string[] = [];
    const plain = toPlainJson(a, { onRepair: (path, reason) => repairs.push(`${reason}:${path}`) });
    expect(plain).toEqual({ id: 1, self: { back: "[circular]" } });
    expect(repairs).toEqual(["circular:self.back"]);
  });

  it("normalizes non-JSON values", () => {
    const plain = toPlainJson({
      n: 12n,
      e: new Error("boom"),
      d: new Date("2026-01-02T03:04:05.000Z"),
      m: new Map([["k", 1]]),
      s: new Set([1, 2]),
      f: () => 1,
      inf: Infinity,
    });
    expect(plain).toEqual({
      n: "12",
      e: { name: "Error", message: "boom" },
      d: "2026-01-02T03:04:05.000Z",
      m: { k: 1 },
      s: [1, 2],
      inf: null,
    });
  });

  it("returns a detached copy", () => {
    const source = { nested: { v: 1 } };
    const plain = toPlainJsonObject(source)!;
    (plain.nested as { v: number }).v = 2;
    expect(source.nested.v).toBe(1);
  });
});

describe("tool results are plain at dispatch", () => {
  it("copies meta so a tool cannot alias engine state", async () => {
    const shared: Record<string, unknown> = { count: 0 };
    shared.loop = shared;
    const tool = defineTool(
      { name: "probe", description: "", parameters: { type: "object", properties: {} } },
      async () => ({ ok: true, content: "ok", meta: shared as never }),
    );
    const results: unknown[] = [];
    await dispatchToolCalls({
      calls: [{ id: "c1", name: "probe", arguments: "{}" }],
      available: new Map([["probe", tool]]),
      steps: 1,
      phase: "act",
      toolContext: {},
      finish: finishTool,
      repeat: new RepeatTracker(false),
      messages: [],
      evidence: [],
      emit: (event: { type: string; meta?: unknown }) => {
        if (event.type === "tool_result") results.push(event.meta);
      },
      emitBackground: () => undefined,
      signal: new AbortController().signal,
      pauseRequested: () => false,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ count: 0, loop: "[circular]" });
    expect(() => JSON.stringify(results[0])).not.toThrow();
  });
});
