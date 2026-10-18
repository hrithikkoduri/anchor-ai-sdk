/**
 * edit_file — exact-string replace with verification.
 *
 * The single biggest failure mode of coding agents is a "replace" that matched
 * the wrong place (or nothing) and silently corrupts a file. This tool refuses
 * both cases:
 *
 *   0 matches  → error: read the file and copy the exact text
 *   >1 matches → error: include more context to make the match unique
 *   1 match    → exact replace, byte-verified by size after writing
 *
 * The old/new strings come over the wire as JSON (so no shell quoting of file
 * content), the whole edit takes TWO exec round-trips (read+size merged;
 * write+byte-verify merged — exec latency dominates on microVMs), and the
 * write-back uses `printf %s` + a `wc -c` re-check, which is portable across
 * GNU and BSD userlands (macOS dev + Linux guests).
 */
import { shq } from "../sandbox/types.js";
import { defineTool, requireSandbox, requireString } from "./types.js";

const MAX_EDIT_BYTES = 200_000;

export const editFileTool = defineTool(
  {
    name: "edit_file",
    description:
      "Replace an exact string in a file. `old_string` must appear exactly once — " +
      "include enough surrounding lines to be unique, and read the file first so the " +
      "text matches byte-for-byte. Use only for targeted edits, not whole-file rewrites.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (relative to the repo root, or absolute).",
        },
        old_string: {
          type: "string",
          description: "Exact text to find — must be unique in the file.",
        },
        new_string: {
          type: "string",
          description: "Replacement text (may be empty to delete).",
        },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  async (input, ctx) => {
    const path = requireString(input, "path");
    const oldString = requireString(input, "old_string");
    const newString =
      typeof input.new_string === "string" ? input.new_string : null;
    if (newString === null)
      throw new Error(`"new_string" must be a string (may be empty)`);

    // 1. Size guard + read in ONE round-trip (exec latency dominates on
    //    microVMs): wc prints the byte count, then cat prints the content.
    const sandbox = requireSandbox(ctx);
    const read = await sandbox.exec(
      `wc -c < ${shq(path)} && cat ${shq(path)}`,
      { timeoutSecs: 60 },
    );
    if (read.exitCode !== 0) {
      return {
        ok: false,
        content: `cannot read ${path}: ${(read.stderr || read.output).trim()}`,
        meta: { path },
      };
    }
    const newline = read.stdout.indexOf("\n");
    if (newline === -1) {
      return {
        ok: false,
        content: `cannot determine size of ${path}`,
        meta: { path },
      };
    }
    const bytes = Number.parseInt(read.stdout.slice(0, newline).trim(), 10);
    if (!Number.isFinite(bytes)) {
      return {
        ok: false,
        content: `cannot determine size of ${path}`,
        meta: { path },
      };
    }
    if (bytes > MAX_EDIT_BYTES) {
      return {
        ok: false,
        content: `${path} is ${bytes} bytes — edit_file refuses files over ${MAX_EDIT_BYTES} bytes. Use bash for generated/large files.`,
        meta: { path },
      };
    }
    const content = read.stdout.slice(newline + 1);

    // 2. Verify the match is unique, in TS-land where exact semantics are ours.
    const first = content.indexOf(oldString);
    if (first === -1) {
      return {
        ok: false,
        content: `old_string not found in ${path}. Read the file and copy the exact text (including whitespace).`,
        meta: { path },
      };
    }
    const second = content.indexOf(oldString, first + oldString.length);
    if (second !== -1) {
      const count = countOccurrences(content, oldString);
      return {
        ok: false,
        content: `old_string appears ${count} times in ${path} — include more surrounding context so it matches exactly once.`,
        meta: { path, occurrences: count },
      };
    }

    // 3. Replace, write back byte-exactly, and verify — ONE round-trip
    //    (printf is a shell builtin; shq escapes arbitrary text into one
    //    argument; wc re-reads the result so a mangled write is caught).
    const updated =
      content.slice(0, first) +
      newString +
      content.slice(first + oldString.length);
    const expectBytes = Buffer.byteLength(updated, "utf8");
    const write = await sandbox.exec(
      `printf %s ${shq(updated)} | tee ${shq(path)} > /dev/null && wc -c < ${shq(path)}`,
      { timeoutSecs: 120 },
    );
    if (write.exitCode !== 0) {
      return {
        ok: false,
        content: `write failed: ${(write.stderr || write.output).trim()}`,
        meta: { path },
      };
    }
    const afterBytes = Number.parseInt(write.stdout.trim(), 10);
    if (afterBytes !== expectBytes) {
      return {
        ok: false,
        content: `write verification failed for ${path}: expected ${expectBytes} bytes, file has ${afterBytes}. File may be corrupted — re-read it.`,
        meta: { path, expectBytes, afterBytes },
      };
    }

    const line = content.slice(0, first).split("\n").length;
    const delta = newString.length - oldString.length;
    return {
      ok: true,
      content: `edited ${path}: replaced 1 occurrence at line ${line} (${delta >= 0 ? "+" : ""}${delta} chars)`,
      meta: {
        path,
        line,
        oldChars: oldString.length,
        newChars: newString.length,
      },
    };
  },
);

/** Non-overlapping occurrence count. Exported for tests. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}
