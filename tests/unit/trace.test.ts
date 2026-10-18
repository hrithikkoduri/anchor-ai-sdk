/**
 * Trace tests — redaction rules and the NDJSON writer (ordering, seq, ts).
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonlTrace } from "../../src/trace/jsonl.js";
import { redact } from "../../src/trace/redact.js";

describe("redact", () => {
  it("masks token-shaped strings", () => {
    expect(redact("token=applb_abc123def")).toBe("token=applb_[REDACTED]");
    expect(redact("key sk-abcdefgh12345678")).toBe("key sk-[REDACTED]");
    expect(redact(`ghp_${"a".repeat(30)}`)).toBe("gh[REDACTED]");
    expect(redact("Authorization: Bearer abc.def-ghi_jkl+mno=")).toBe("Authorization: Bearer [REDACTED]");
    expect(redact("https://x-access-token:hunter2@github.com")).toBe("https://[REDACTED]@github.com");
  });

  it("leaves ordinary text alone", () => {
    expect(redact("npm test exited 1 after 3.2s")).toBe("npm test exited 1 after 3.2s");
  });
});

describe("JsonlTrace", () => {
  it("writes ordered, redacted NDJSON with seq and ts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "anchor-trace-"));
    try {
      const trace = new JsonlTrace(path.join(dir, "nested", "run.jsonl"));
      const s0 = await trace.record({ type: "run_started", task: "fix it" });
      const s1 = await trace.record({ type: "tool_result", content: "leak: sk-abcdefgh12345678" });
      expect([s0, s1]).toEqual([0, 1]);
      expect(trace.length).toBe(2);

      const lines = (await readFile(trace.filePath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]!) as { seq: number; ts: string; event: { type: string } };
      expect(first.seq).toBe(0);
      expect(first.event.type).toBe("run_started");
      expect(new Date(first.ts).toISOString()).toBe(first.ts);

      // Redaction applied at the sink: the raw token never hits disk.
      expect(lines[1]).toContain("sk-[REDACTED]");
      expect(lines[1]).not.toContain("sk-abcdefgh12345678");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
