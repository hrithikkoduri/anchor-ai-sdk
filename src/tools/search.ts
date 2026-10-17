/**
 * search — ripgrep (preferred) with a `git grep` fallback, then plain `grep`.
 *
 * Why the ladder: the Heyo images and dev machines differ in what's installed.
 * `rg` is best; `git grep` is guaranteed wherever the workspace is a git repo
 * (always, for us) and knows to skip .git; `grep -rIn` is the last resort.
 *
 * Fixed-string mode is the default — the model searching for `foo(bar)` should
 * not trip over regex syntax. Set regex: true for real patterns.
 */
import { shq } from "../sandbox/types.js";
import { truncate } from "./truncate.js";
import { defineTool, optionalBoolean, optionalNumber, optionalString, requireString } from "./types.js";

const RC_MARKER = "__harness_rc=";

export const searchTool = defineTool(
  {
    name: "search",
    description:
      "Search the repository for a string (fixed-string by default, at most 50 matches). " +
      "Returns file:line:text. Use this to find code, symbols, and error messages before reading files.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text to find (or a regex when regex: true)." },
        path: { type: "string", description: "Directory or file to search (default: the repo root)." },
        regex: { type: "boolean", description: "Treat pattern as a regular expression (default false)." },
        max_results: { type: "integer", description: "Maximum matches to return (default 50, max 200)." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  async (input, ctx) => {
    const pattern = requireString(input, "pattern");
    const path = optionalString(input, "path") ?? ".";
    const regex = optionalBoolean(input, "regex") ?? false;
    const max = Math.max(1, Math.min(200, Math.floor(optionalNumber(input, "max_results", 50))));
    const head = max + 1; // one extra line reveals truncation

    const rgFlag = regex ? "" : " --fixed-strings";
    // git grep / grep default to BASIC regex where \d etc. don't work — -E
    // gives them extended regex, which is the portable common denominator.
    const grepFlag = regex ? " -E" : " -F";
    // sed (not head) caps the output: head closes the pipe early and SIGPIPEs
    // the searcher (exit 141), which we would misread as an error.
    const cap = `| sed -n "1,${head}p"; echo ${RC_MARKER}\${PIPESTATUS[0]}`;

    const cmd = [
      `if command -v rg >/dev/null 2>&1; then`,
      `  rg --line-number --no-heading --color=never${rgFlag} -- ${shq(pattern)} ${shq(path)} ${cap};`,
      `elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
      `  git grep -nI${grepFlag} --untracked -e ${shq(pattern)} -- ${shq(path)} ${cap};`,
      `else`,
      `  grep -rIn${grepFlag} --exclude-dir=.git --exclude-dir=node_modules ${shq(pattern)} ${shq(path)} ${cap};`,
      `fi`,
    ].join("\n");

    const r = await ctx.sandbox.exec(cmd, { timeoutSecs: 120 });

    // Split off the rc marker to learn the real exit code behind the pipe.
    const lines = r.output.split("\n");
    let markerIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.startsWith(RC_MARKER)) {
        markerIdx = i;
        break;
      }
    }
    let rc = r.exitCode;
    let matchLines = lines;
    if (markerIdx !== -1) {
      rc = Number.parseInt(lines[markerIdx]!.slice(RC_MARKER.length), 10);
      matchLines = [...lines.slice(0, markerIdx), ...lines.slice(markerIdx + 1)];
    }
    matchLines = matchLines.filter((l) => l.trim() !== "");

    if (rc === 1) {
      return { ok: true, content: `no matches for ${JSON.stringify(pattern)}`, meta: { pattern, path, matches: 0 } };
    }
    if (rc > 1 || (rc !== 0 && matchLines.length === 0)) {
      return {
        ok: false,
        content: `search failed (exit ${rc}): ${(r.stderr || r.output).trim().split("\n").slice(0, 5).join("\n")}`,
        meta: { pattern, path, exitCode: rc },
      };
    }

    const truncated = matchLines.length > max;
    const shown = truncated ? matchLines.slice(0, max) : matchLines;
    const note = truncated ? `\n[... showing first ${max} of at least ${matchLines.length} matches — refine the pattern ...]` : "";
    return {
      ok: true,
      content: truncate(`${shown.length}${truncated ? "+" : ""} match(es) for ${JSON.stringify(pattern)} in ${path}:\n${shown.join("\n")}${note}`),
      meta: { pattern, path, matches: shown.length, truncated },
    };
  },
);
