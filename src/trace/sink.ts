/**
 * TraceSink + TraceFanout — one event stream, many sinks, one journal.
 *
 * The fanout owns what every persistence path must agree on:
 *
 *   - ONE sequence number. The NDJSON file, the database rows, and live
 *     payloads all quote the same seq, so replay and live ordering cannot
 *     disagree.
 *   - Redaction applied once, deeply, BEFORE any sink sees the event — no
 *     path can forget it (a sink never needs to know the rules).
 *   - Per-sink serialization: a slow sink never reorders its own writes —
 *     and a broken sink never kills the run (errors go to `onError` and the
 *     chain moves on; a trace is never more important than the work).
 */
import { toPlainJson, type JsonObject, type JsonValue } from "../json.js";
import type { AgentEvent } from "../engine/events.js";
import { redact } from "./redact.js";

/**
 * One sequenced, redacted event — the unit every sink records. Constructed by
 * a `TraceFanout`; don't build these by hand unless you redact via
 * `redactEvent` yourself.
 */
export interface TracedEvent {
  /** Monotonic per fanout, starting at 0: the order the engine emitted. */
  seq: number;
  /** ISO timestamp of the fanout's receipt. */
  ts: string;
  event: AgentEvent;
}

/** Anything durable (a file, a table, a websocket, an OTel exporter). */
export interface TraceSink {
  /** Short name for diagnostics, e.g. "jsonl", "db", "live". */
  name: string;
  record(entry: TracedEvent): void | Promise<void>;
}

export interface TraceFanoutOptions {
  /** Called when a sink throws; default: swallowed. */
  onError?: (sink: TraceSink, error: unknown) => void;
}

export class TraceFanout {
  private seq = 0;
  private readonly tails = new Map<TraceSink, Promise<void>>();

  constructor(
    readonly sinks: TraceSink[],
    private readonly options: TraceFanoutOptions = {},
  ) {}

  /** How many events have been fanned out (the next seq). */
  get count(): number {
    return this.seq;
  }

  /** Assign the sequence number once, redact once, deliver to every sink. */
  record(event: AgentEvent): number {
    const entry: TracedEvent = {
      seq: this.seq++,
      ts: new Date().toISOString(),
      event: redactEvent(event),
    };
    for (const sink of this.sinks) {
      const previous = this.tails.get(sink) ?? Promise.resolve();
      const next = previous
        .then(() => sink.record(entry))
        .catch((error) => {
          this.options.onError?.(sink, error);
        });
      this.tails.set(sink, next);
    }
    return entry.seq;
  }

  /** Wait until every sink has drained (call at run end). */
  async flush(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }
}

/**
 * Deep redaction over a plain copy: every string in the event gets the rules,
 * and the copy itself is guaranteed serializable (cycles, BigInt, and class
 * instances are normalized first) so one bad payload cannot stall a sink.
 */
export function redactEvent(event: AgentEvent): AgentEvent {
  return redactDeep(toPlainJson(event)) as AgentEvent;
}

function redactDeep(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item) ?? null);
  if (value && typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item);
    return out;
  }
  return value;
}
