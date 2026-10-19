/**
 * read_file — page through a file with line numbers.
 *
 * Implemented as one `awk` slice in the guest (portable: mawk/gawk and BSD awk
 * all support this): numbered lines + a trailer saying which range of how many.
 * Paging exists so the model reads windows, not whole files.
 */
import { shq } from "../sandbox/types.js";
import { spillOrTruncate } from "./truncate.js";
import {
  defineTool,
  optionalNumber,
  requireSandbox,
  requireString,
} from "./types.js";

export const readFileTool = defineTool(
  {
    name: "read_file",
    description:
      "Read a file from the sandbox with line numbers. Use offset/limit to page " +
      "through big files instead of reading them whole.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (relative to the repo root, or absolute).",
        },
        offset: {
          type: "integer",
          description: "First line to read (1-based, default 1).",
        },
        limit: {
          type: "integer",
          description: "How many lines (default 200, max 2000).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async (input, ctx) => {
    const path = requireString(input, "path");
    const offset = Math.max(1, Math.floor(optionalNumber(input, "offset", 1)));
    const limit = Math.max(
      1,
      Math.min(2000, Math.floor(optionalNumber(input, "limit", 200))),
    );
    const end = offset + limit - 1;

    const cmd =
      `awk -v s=${offset} -v e=${end} '` +
      `NR>=s && NR<=e { printf "%6d\\t%s\\n", NR, $0 } ` +
      `END { ` +
      `if (s > NR) printf "-- file has %d lines; offset %d is past the end --\\n", NR, s; ` +
      `else if (NR > e || s > 1) printf "-- lines %d-%d of %d --\\n", s, (e < NR ? e : NR), NR ` +
      `}' ` +
      shq(path);

    const r = await requireSandbox(ctx).exec(cmd, {
      timeoutSecs: 120,
      concurrent: true,
    });
    if (r.exitCode !== 0) {
      return {
        ok: false,
        content: `cannot read ${path}: ${(r.stderr || r.output).trim()}`,
        meta: { path },
      };
    }
    return {
      ok: true,
      content: await spillOrTruncate(
        `read ${path} (lines ${offset}–${end}):\n${r.output.trimEnd()}`,
        { sandbox: ctx.sandbox, label: "read_file" },
      ),
      meta: { path, from: offset, to: Math.min(end, offset + limit - 1) },
    };
  },
  { readOnly: true },
);
