/**
 * How a batch reads back: one label per op, its output under it, each output
 * capped and the whole result capped, with the full log named whenever
 * anything was clipped. Pure, so the caps are tested without a sandbox.
 */
import { truncate } from "../truncate.js";

export type OpStatus = "ok" | "failed" | "refused" | "skipped";

export interface OpReport {
  index: number;
  op: string;
  /** What the op acted on: a path, a command, a pattern. */
  target: string;
  status: OpStatus;
  /** The label's tail after the status: "1 replacement, +4/−2", "exit 1, 3 failed". */
  detail?: string;
  /** Text for the model, uncapped (the caps are applied when rendering). */
  body: string;
  cached?: boolean;
  /** An ok edit or write whose result was already in place: nothing written. */
  alreadyApplied?: boolean;
}

export interface RenderCaps {
  opLines: number;
  totalLines: number;
  opChars: number;
  totalChars: number;
}

export const BATCH_RENDER_CAPS: RenderCaps = {
  opLines: 300,
  totalLines: 600,
  opChars: 20_000,
  totalChars: 60_000,
};

const oneLine = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

export function opLabel(
  report: Pick<OpReport, "index" | "op" | "target" | "status" | "detail" | "cached" | "alreadyApplied">,
): string {
  const status = report.status === "skipped" ? "not run" : report.alreadyApplied ? "already applied" : report.status;
  const tail = [report.detail, report.cached ? "cached" : ""].filter(Boolean).join(", ");
  const target = report.op === "bash" ? `\`${oneLine(report.target, 70)}\`` : oneLine(report.target, 90);
  return `#${report.index} ${report.op} ${target} — ${status}${tail ? ` (${tail})` : ""}`;
}

/**
 * The largest per-op line allowance that keeps the total within `budget`
 * ("water-filling"): short outputs keep every line, long ones share the rest.
 */
export function allotment(lengths: readonly number[], budget: number): number {
  const total = lengths.reduce((sum, n) => sum + n, 0);
  if (total <= budget) return Math.max(1, ...lengths);
  const sorted = [...lengths].sort((a, b) => a - b);
  let remaining = budget;
  for (let i = 0; i < sorted.length; i++) {
    const share = Math.floor(remaining / (sorted.length - i));
    if (sorted[i]! > share) return Math.max(1, share);
    remaining -= sorted[i]!;
  }
  return Math.max(1, sorted[sorted.length - 1]!);
}

const lines = (text: string) => (text === "" ? 0 : text.split("\n").length);

export interface Rendered {
  content: string;
  /** Some op's output was clipped here; the full log has it. */
  clipped: boolean;
}

export function renderBatch(
  reports: readonly OpReport[],
  header: string,
  logNote: string,
  caps: RenderCaps = BATCH_RENDER_CAPS,
): Rendered {
  const bodies = reports.map((report) => report.body.trimEnd());
  const lineAllow = Math.min(caps.opLines, allotment(bodies.map((body) => Math.min(lines(body), caps.opLines)), caps.totalLines));
  const charAllow = Math.min(caps.opChars, allotment(bodies.map((body) => Math.min(body.length, caps.opChars)), caps.totalChars));
  let clipped = false;
  const sections = reports.map((report, i) => {
    const body = bodies[i]!;
    const capped = body === "" ? "" : truncate(body, { maxLines: lineAllow, maxChars: charAllow });
    const cut = capped !== body;
    if (cut) clipped = true;
    return [
      opLabel(report),
      ...(capped ? [capped] : []),
      ...(cut ? [`[#${report.index}: output clipped here — ${logNote}]`] : []),
    ].join("\n");
  });
  return { content: [header, ...sections].join("\n\n"), clipped };
}

/** "3 failed" from a test runner's summary, when the output has one. */
export function failedTests(output: string): number | undefined {
  const match =
    /Tests?:?\s+(\d+)\s+failed/i.exec(output) ??
    /(\d+)\s+failed(?:,|\s|\|)/i.exec(output) ??
    /(\d+)\s+(?:failing|tests? failed)/i.exec(output);
  const n = match ? Number(match[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
