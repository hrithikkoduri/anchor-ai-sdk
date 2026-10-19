/**
 * JsonlTrace — append-only NDJSON trace files, one line per event:
 *
 *   {"seq":0,"ts":"2026-10-17T…","event":{"type":"run_started",…}}
 *
 * A TraceSink: it records the entries its `TraceFanout` produced — already
 * sequenced and redacted (see sink.ts), so the file, the database, and the
 * live stream always agree and no persistence path can forget redaction.
 * Generic on purpose: CLIs, products, and eval runners all want durable run
 * traces, and the file is what a PR trace link points at.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TraceSink, TracedEvent } from "./sink.js";

export class JsonlTrace implements TraceSink {
  readonly name = "jsonl";
  private count = 0;
  private dirEnsured = false;

  constructor(readonly filePath: string) {}

  /** Append one entry. The fanout already sequenced and redacted it. */
  async record(entry: TracedEvent): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      this.dirEnsured = true;
    }
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    this.count += 1;
  }

  /** How many events have been recorded. */
  get length(): number {
    return this.count;
  }
}
