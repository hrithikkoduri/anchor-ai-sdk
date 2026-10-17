/**
 * Trace redaction — token-shaped strings never reach disk or the database.
 *
 * Traces record everything (prompts, outputs, commands), so they are the most
 * likely place for a secret to leak by accident: an env dump, an echoed URL
 * with an embedded credential, a provider key in an error. One `redact()` at
 * the persistence boundary covers every sink.
 */

const RULES: Array<[RegExp, string]> = [
  // Heyo app-tokens
  [/applb_[A-Za-z0-9_]+/g, "applb_[REDACTED]"],
  // OpenAI-style keys (also covers sk-or-v1-…)
  [/sk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]"],
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh[REDACTED]"],
  // Authorization headers
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED]"],
  // credentials embedded in URLs: https://user:secret@host
  [/(https?:\/\/)[^:/\s]+:[^@/\s]+@/g, "$1[REDACTED]@"],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
