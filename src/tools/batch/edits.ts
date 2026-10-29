/**
 * All-or-nothing edits for one file, in TS-land where exact semantics are
 * ours. Pure: the caller reads the file once, applies every edit here in
 * order (each sees the previous one's result), and writes once — or, when any
 * `old` fails to match, writes nothing and names the edit that failed.
 *
 * Retry safety: an edit whose `old` is gone but whose `new` is already there
 * (or, when `new` contains `old`, already stands everywhere `old` does) is
 * `alreadyApplied` — a model retrying a partly applied batch must not apply it
 * twice or see a fresh failure. A deletion (`new` empty) has nothing to find,
 * so a missing `old` still fails.
 */
import { countOccurrences } from "../edit-file.js";

export interface FileEdit {
  /** The op number, for the failure message. */
  index: number;
  old: string;
  new: string;
  replaceAll: boolean;
}

export interface EditStat {
  index: number;
  replacements: number;
  added: number;
  removed: number;
  alreadyApplied?: boolean;
}

export type EditOutcome =
  | { ok: true; content: string; stats: EditStat[] }
  | { ok: false; failed: number; reason: string };

/**
 * Lines a replacement adds and removes, ignoring the lines it shares at the
 * start and end (context the model included to make `old` unique).
 */
export function lineDelta(oldText: string, newText: string): { added: number; removed: number } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
    tail += 1;
  if (oldText === newText) return { added: 0, removed: 0 };
  return {
    added: newText === "" ? 0 : b.length - head - tail,
    removed: oldText === "" ? 0 : a.length - head - tail,
  };
}

export function applyEdits(content: string, edits: readonly FileEdit[]): EditOutcome {
  let current = content;
  const stats: EditStat[] = [];
  for (const edit of edits) {
    const count = countOccurrences(current, edit.old);
    const present = edit.new === "" ? 0 : countOccurrences(current, edit.new);
    const applied =
      count === 0
        ? present > 0
        : edit.new.includes(edit.old) && present >= count && (count === 1 || edit.replaceAll);
    if (applied) {
      stats.push({ index: edit.index, replacements: 0, added: 0, removed: 0, alreadyApplied: true });
      continue;
    }
    if (count === 0)
      return {
        ok: false,
        failed: edit.index,
        reason: `edit #${edit.index}: "old" not found — read the file and copy the exact text (whitespace included)`,
      };
    if (count > 1 && !edit.replaceAll)
      return {
        ok: false,
        failed: edit.index,
        reason: `edit #${edit.index}: "old" appears ${count} times — include more surrounding lines so it matches once, or set replaceAll`,
      };
    current = edit.replaceAll ? current.split(edit.old).join(edit.new) : current.replace(edit.old, () => edit.new);
    const delta = lineDelta(edit.old, edit.new);
    stats.push({
      index: edit.index,
      replacements: count,
      added: delta.added * count,
      removed: delta.removed * count,
    });
  }
  return { ok: true, content: current, stats };
}
