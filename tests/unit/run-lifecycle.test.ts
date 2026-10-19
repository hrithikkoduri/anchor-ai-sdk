/**
 * runAgent lifecycle: trace sinks, heartbeat, and polled cancel — the run
 * loop owns them, so no product has to hand-roll timers around it.
 */
import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/engine/loop.js";
import type { LLMClient } from "../../src/llm/types.js";
import type { TraceSink, TracedEvent } from "../../src/trace/sink.js";
import { call, scripted } from "../helpers/scripted.js";

describe("runAgent lifecycle", () => {
  it("fans every event to the sinks, one sequence, flushed before resolving", async () => {
    const seenA: TracedEvent[] = [];
    const seenB: TracedEvent[] = [];
    const sinkA: TraceSink = {
      name: "a",
      record: (entry) => {
        seenA.push(entry);
      },
    };
    const sinkB: TraceSink = {
      name: "b",
      record: async (entry) => {
        seenB.push(entry);
      },
    };
    const result = await runAgent(
      { task: "say hello" },
      { llm: scripted([{ text: "hello" }]), traceSinks: [sinkA, sinkB] },
    );
    expect(result.ok).toBe(true);
    // Flushed before the result: the closing event is already in both sinks.
    expect(seenA.map((entry) => entry.event.type)).toEqual(
      seenB.map((entry) => entry.event.type),
    );
    expect(seenA[0]!.event.type).toBe("run_started");
    expect(seenA.at(-1)!.event.type).toBe("run_finished");
    expect(seenA.map((entry) => entry.seq)).toEqual(
      seenA.map((_entry, index) => index),
    );
  });

  it("contains a broken sink without killing the run", async () => {
    const seen: TracedEvent[] = [];
    const result = await runAgent(
      { task: "say hello" },
      {
        llm: scripted([{ text: "hello" }]),
        traceSinks: [
          {
            name: "broken",
            record: () => {
              throw new Error("sink down");
            },
          },
          {
            name: "ok",
            record: (entry) => {
              seen.push(entry);
            },
          },
        ],
      },
    );
    expect(result.ok).toBe(true);
    expect(seen.at(-1)!.event.type).toBe("run_finished");
  });

  it("heartbeats immediately and while the run lives, then stops", async () => {
    let beats = 0;
    const result = await runAgent(
      { task: "say hello" },
      {
        llm: scripted([{ text: "hi" }]),
        heartbeat: {
          everyMs: 5,
          beat: () => {
            beats += 1;
            throw new Error("lease db down"); // failures are swallowed
          },
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(beats).toBeGreaterThanOrEqual(1);
    // The timer is stopped when the run ends — no beating after death.
    const settled = beats;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(beats).toBe(settled);
  });

  it("polls a durable cancel flag and concludes cancelled", async () => {
    const base = scripted([
      call("bash", { command: "true" }),
      { text: "done" },
    ]);
    const slow: LLMClient = {
      ...base,
      stream: async (request, onDelta) => {
        // Slow enough for the poll (everyMs: 1) to land mid-call.
        await new Promise((resolve) => setTimeout(resolve, 30));
        return base.stream(request, onDelta);
      },
    };
    let polls = 0;
    const result = await runAgent(
      { task: "long work" },
      {
        llm: slow,
        cancel: {
          everyMs: 1,
          isCancelled: () => {
            polls += 1;
            return true;
          },
        },
      },
    );
    expect(result.reason).toBe("cancelled");
    expect(result.ok).toBe(false);
    expect(polls).toBeGreaterThanOrEqual(1);
  });
});
