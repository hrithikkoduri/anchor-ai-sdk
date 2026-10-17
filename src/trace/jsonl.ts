/**
 * JsonlTrace — append-only NDJSON trace files, one line per event:
 *
 *   {"seq":0,"ts":"2026-10-17T…","event":{"type":"run_started",…}}
 *
 * Generic on purpose: any consumer that wants durable run traces (CLIs,
 * products, eval runners) can use it. Redaction happens here so no sink can
 * forget it. The seq is monotonic per file — the same order the engine
 * emitted — which is what makes the file replayable as a journal.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redact } from "./redact.js";

export class JsonlTrace {
  private seq = 0;
  private dirEnsured = false;

  constructor(readonly filePath: string) {}

  /** Append one redacted NDJSON line; returns the seq assigned to the event. */
  async record(event: unknown): Promise<number> {
    const seq = this.seq++;
    const line = redact(JSON.stringify({ seq, ts: new Date().toISOString(), event }));
    if (!this.dirEnsured) {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      this.dirEnsured = true;
    }
    await appendFile(this.filePath, `${line}\n`, "utf8");
    return seq;
  }

  /** How many events have been recorded (the next seq). */
  get length(): number {
    return this.seq;
  }
}
