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
    out = out.slice(0, headChars) + `\n[... ${omitted} chars omitted ...]\n` + out.slice(out.length - tailChars);
  }

  return out;
}
