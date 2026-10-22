import { shq, type Sandbox } from "../sandbox/types.js";

/**
 * The output truncator — every tool result passes through here before it can
 * reach the model's context. One place, one policy:
 *
 *   head + "[... N lines omitted ...]" + tail
 *
 * Defaults: 300 lines / 20k chars per tool result. The character pass is a
 * second safety net for pathological single lines (minified bundles etc.).
 */
export interface TruncateOptions {
  maxLines?: number;
  maxChars?: number;
}

export const TRUNCATE_DEFAULTS = { maxLines: 300, maxChars: 20_000 } as const;

/** Absolute ceiling for any tool result entering the model context. */
export const TOOL_RESULT_MAX_CHARS = 100_000;

export function truncate(text: string, opts: TruncateOptions = {}): string {
  const maxLines = opts.maxLines ?? TRUNCATE_DEFAULTS.maxLines;
  const maxChars = opts.maxChars ?? TRUNCATE_DEFAULTS.maxChars;

  let out = text;

  // Line budget: keep 60% of the head, 40% of the tail — beginnings and ends
  // of outputs carry the signal (commands, errors, summaries).
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    const headLines = Math.ceil(maxLines * 0.6);
    const tailLines = maxLines - headLines;
    const omitted = lines.length - maxLines;
    out = [
      ...lines.slice(0, headLines),
      `[... ${omitted} lines omitted ...]`,
      ...lines.slice(lines.length - tailLines),
    ].join("\n");
  }

  // Character budget for very long single lines.
  if (out.length > maxChars) {
    const headChars = Math.floor(maxChars * 0.6);
    const tailChars = maxChars - headChars;
    const omitted = out.length - headChars - tailChars;
    out =
      out.slice(0, headChars) +
      `\n[... ${omitted} chars omitted ...]\n` +
      out.slice(out.length - tailChars);
  }

  return out;
}

/**
 * Spill-or-truncate — the lossless variant of the boundary.
 *
 * Truncation throws information away; when a sandbox is present we save the
 * FULL output to the sandbox's scratch dir instead and point the model at it,
 * so clipped middles are addressable (read slices / search) rather than lost
 * or re-run. Best-effort by construction: any failure falls back to plain
 * truncation and never breaks the tool.
 */
export interface SpillTarget {
  sandbox?: Sandbox;
  /** File-name hint for the spill ({label}-<stamp>.txt). */
  label?: string;
}

/** Do not attempt to persist absurd payloads — truncate-and-note instead. */
const SPILL_MAX_CHARS = 4_000_000;
let spillSeq = 0;

export async function spillOrTruncate(
  text: string,
  target: SpillTarget = {},
  opts: TruncateOptions = {},
): Promise<string> {
  const clipped = truncate(text, opts);
  if (clipped === text) return clipped; // nothing was lost
  const sandbox = target.sandbox;
  if (!sandbox) return clipped; // no sandbox (chat/plain loops) — classic behavior
  if (text.length > SPILL_MAX_CHARS) {
    return `${clipped}\n[... output too large to save (${Math.round(text.length / 1024)} KB) ...]`;
  }

  const label = (target.label ?? "output").replace(/[^a-zA-Z0-9_-]/g, "");
  const file = `${sandbox.scratch}/out/${label}-${Date.now().toString(36)}${(spillSeq++).toString(36)}.txt`;
  const dir = file.slice(0, file.lastIndexOf("/"));
  try {
    const b64 = Buffer.from(text, "utf8").toString("base64");
    const write = await sandbox.exec(
      `mkdir -p ${shq(dir)} && printf %s ${shq(b64)} | base64 -d > ${shq(file)}`,
      { timeoutSecs: 120 },
    );
    if (write.exitCode !== 0) return clipped;
  } catch {
    return clipped;
  }

  const lines = text.split("\n").length;
  return (
    `${clipped}\n` +
    `[... full output saved: ${file} (${lines} lines, ${Math.round(text.length / 1024)} KB). ` +
    `Read slices with read_file(path, offset, limit), or search it with search(path, pattern) ...]`
  );
}


/**
 * The public boundary for consumer tools. Built-in tools use the same path;
 * this exists so a product tool never has to reimplement truncation/spill.
 */
export async function boundToolResult(
  content: string,
  target: SpillTarget = {},
  opts: TruncateOptions = {},
): Promise<string> {
  return spillOrTruncate(content, target, {
    maxChars: TOOL_RESULT_MAX_CHARS,
    ...opts,
  });
}
