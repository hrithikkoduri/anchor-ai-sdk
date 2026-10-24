/**
 * Trace tests — redaction rules, the fanout (one sequence number and one
 * redaction before every sink), and the NDJSON writer.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonlTrace } from "../../src/trace/jsonl.js";
import { redact } from "../../src/trace/redact.js";
import { TraceFanout, redactEvent, type TracedEvent } from "../../src/trace/sink.js";

describe("redact", () => {
  it("masks token-shaped strings", () => {
    expect(redact("token=applb_abc123def")).toBe("token=applb_[REDACTED]");
    expect(redact("key sk-abcdefgh12345678")).toBe("key sk-[REDACTED]");
    expect(redact(`ghp_${"a".repeat(30)}`)).toBe("gh[REDACTED]");
    expect(redact("Authorization: Bearer abc.def-ghi_jkl+mno=")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(redact("https://x-access-token:hunter2@github.com")).toBe(
      "https://[REDACTED]@github.com",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(redact("npm test exited 1 after 3.2s")).toBe(
      "npm test exited 1 after 3.2s",
    );
  });
});

describe("redactEvent", () => {
  it("produces a serializable copy even when the payload has a cycle", () => {
    const meta: Record<string, unknown> = { a: 1 };
    meta.self = meta;
    const event = {
      type: "tool_result",
      name: "x",
      ok: true,
      content: "ok",
      meta,
    } as unknown as Parameters<typeof redactEvent>[0];
    const safe = redactEvent(event) as unknown as { meta: { self: unknown } };
    expect(safe.meta.self).toBe("[circular]");
    expect(() => JSON.stringify(safe)).not.toThrow();
  });
});

describe("TraceFanout", () => {
  it("gives every sink the same sequenced entry, redacted deeply", async () => {
    const seenA: TracedEvent[] = [];
    const seenB: TracedEvent[] = [];
    const fanout = new TraceFanout([
      { name: "a", record: (entry) => void seenA.push(entry) },
      { name: "b", record: async (entry) => void seenB.push(entry) },
    ]);
    const token = `ghs_${"c".repeat(30)}`;
    expect(
      fanout.record({ type: "run_started", text: "fix it", phases: ["fix"] }),
    ).toBe(0);
    expect(
      fanout.record({
        type: "tool_call",
        phase: "fix",
        step: 1,
        name: "bash",
        // The token sits in a NESTED field: redaction must go deep.
        input: { command: `gh auth login --with-token <<< ${token}` },
      }),
    ).toBe(1);
    await fanout.flush();

    expect(seenA.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(seenB.map((entry) => entry.seq)).toEqual([0, 1]);
    // One entry instance, one seq, one redaction — shared by both sinks.
    expect(seenA[0]).toBe(seenB[0]);
    expect(fanout.count).toBe(2);

    const second = JSON.stringify(seenA[1]);
    expect(second).not.toContain(token);
    expect(second).toContain("gh[REDACTED]");
    expect(new Date(seenA[0]!.ts).toISOString()).toBe(seenA[0]!.ts);
  });

  it("serializes each sink's deliveries and contains sink failures", async () => {
    const order: string[] = [];
    const slow = {
      name: "slow",
      record: async () => {
        order.push("start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("end");
      },
    };
    const broken = {
      name: "broken",
      record: () => {
        throw new Error("sink down");
      },
    };
    const errors: string[] = [];
    const fanout = new TraceFanout([slow, broken], {
      onError: (sink) => void errors.push(sink.name),
    });
    fanout.record({ type: "run_started", text: "one", phases: [] });
    fanout.record({ type: "run_started", text: "two", phases: [] });
    await fanout.flush();

    // Never two in flight for one sink — no self-reordering under load.
    expect(order).toEqual(["start", "end", "start", "end"]);
    // The broken sink fails twice; the run is unaffected.
    expect(errors).toEqual(["broken", "broken"]);
  });
});

describe("JsonlTrace", () => {
  it("writes the fanout's entries as ordered NDJSON with seq and ts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-trace-"));
    try {
      const trace = new JsonlTrace(path.join(dir, "nested", "run.jsonl"));
      const fanout = new TraceFanout([trace]);
      fanout.record({ type: "run_started", text: "fix it", phases: ["fix"] });
      fanout.record({
        type: "error",
        message: "leak: sk-abcdefgh12345678",
      });
      await fanout.flush();
      expect(trace.length).toBe(2);

      const lines = (await readFile(trace.filePath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]!) as {
        seq: number;
        ts: string;
        event: { type: string };
      };
      expect(first.seq).toBe(0);
      expect(first.event.type).toBe("run_started");
      expect(new Date(first.ts).toISOString()).toBe(first.ts);

      // Redaction happened before the sink: the raw token never hits disk.
      expect(lines[1]).toContain("sk-[REDACTED]");
      expect(lines[1]).not.toContain("sk-abcdefgh12345678");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
