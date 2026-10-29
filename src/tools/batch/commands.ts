/**
 * Does a shell command change the workspace? Pure, and deliberately
 * conservative: a command is read-only only when every segment is a known
 * read (ls, cat, rg, git status…) or check (tests, typecheck, lint without
 * --fix), with no redirection into a file and no command substitution.
 * Anything unrecognised counts as a write.
 *
 * Two consumers, one classifier. The batch uses `isReadOnlyCommand`: once a
 * write has run, a later failure stops the batch by default. The engine's
 * dispatcher uses `commandKind(...) === "read"` to run independent `bash`
 * calls concurrently; a check is not eligible there, because test runners and
 * type checkers write caches and build info and may bind ports.
 */

const READ_HEADS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "stat", "file", "pwd", "echo",
  "printf", "true", "false", "test", "[", "diff", "cmp", "tree", "du", "df", "which", "type", "uniq",
  "cut", "tr", "jq", "nl", "basename", "dirname", "realpath", "readlink", "date", "uname", "whoami",
  "id", "sha256sum", "shasum", "md5sum", "column", "seq", "sleep", "exit",
]);

const GIT_READS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "ls-files", "ls-tree", "grep", "rev-parse", "blame", "describe",
  "shortlog", "cat-file", "merge-base", "rev-list", "name-rev",
]);

/** Test runners, type checkers, linters (their own output dirs aside). */
const CHECK_HEADS: ReadonlySet<string> = new Set(["vitest", "jest", "pytest", "mypy", "pyright", "playwright", "eslint", "tsc", "ruff", "prettier", "mocha"]);
const CHECK_SCRIPT = /^(?:test|vitest|jest|typecheck|check|lint|tsc)(?:$|:)/;
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const RUNNERS: ReadonlySet<string> = new Set(["npx", "bunx", "pnpx"]);

const withoutQuoted = (command: string) => command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");

function checkTool(head: string, args: string[]): boolean {
  if (args.some((arg) => arg === "--fix" || arg === "--write" || arg.startsWith("--fix="))) return false;
  if (head === "tsc") return args.includes("--noEmit");
  if (head === "ruff") return args[0] === "check";
  if (head === "prettier") return args.includes("--check");
  return CHECK_HEADS.has(head);
}

export type CommandKind = "read" | "check" | "write";

const RANK: Record<CommandKind, number> = { read: 0, check: 1, write: 2 };

const checkOr = (ok: boolean): CommandKind => (ok ? "check" : "write");

function segmentKind(segment: string): CommandKind {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i += 1;
  if (words[i] === "env") i += 1;
  if (words[i] === "timeout") {
    i += 1;
    while (words[i]?.startsWith("-")) i += 1;
    i += 1;
  }
  const head = words[i]?.split("/").at(-1);
  const args = words.slice(i + 1);
  const readOr = (ok: boolean): CommandKind => (ok ? "read" : "write");
  if (head === undefined) return "read";
  if (head === "cd") return "read";
  // Reads that can still name an output file.
  if (head === "tree") return readOr(!args.some((arg) => arg === "-o"));
  if (head === "uniq") return readOr(args.filter((arg) => !arg.startsWith("-")).length < 2);
  if (READ_HEADS.has(head)) return "read";
  if (head === "sed") return readOr(!args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place")));
  if (head === "find") return readOr(!args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(arg)));
  if (head === "sort") return readOr(!args.some((arg) => arg === "-o" || arg.startsWith("--output")));
  if (head === "git") {
    const sub = args[0] === "-C" ? args[2] : args[0];
    return readOr(sub !== undefined && GIT_READS.has(sub) && !args.some((arg) => arg.startsWith("--output")));
  }
  if (PACKAGE_MANAGERS.has(head)) {
    const script = ["run", "run-script"].includes(args[0] ?? "") ? args[1] : args[0];
    if (script && CHECK_SCRIPT.test(script)) return checkOr(!args.includes("--fix"));
    if (head !== "npm" && ["exec", "x", "dlx"].includes(args[0] ?? "")) return checkOr(checkTool(args[1] ?? "", args.slice(2)));
    return "write";
  }
  if (RUNNERS.has(head)) {
    const rest = args.filter((arg) => arg !== "--yes" && arg !== "-y" && arg !== "--no-install");
    return checkOr(checkTool(rest[0] ?? "", rest.slice(1)));
  }
  if (/^python3?$/.test(head)) return checkOr(args[0] === "-m" && ["pytest", "mypy", "unittest"].includes(args[1] ?? ""));
  if (head === "go") return checkOr(["test", "vet"].includes(args[0] ?? ""));
  if (head === "cargo") return checkOr(["test", "check", "clippy"].includes(args[0] ?? "") && !args.includes("--fix"));
  if (head === "make") return checkOr(["test", "check", "lint"].includes(args[0] ?? ""));
  return checkOr(checkTool(head, args));
}

/** The most effectful segment decides: any write → write, else any check → check. */
export function commandKind(command: string): CommandKind {
  if (/\$\(|`/.test(command)) return "write";
  const bare = withoutQuoted(command).replace(/\d*>&\d+|&>\s*\/dev\/null|\d*>>?\s*\/dev\/null/g, " ");
  if (/>/.test(bare) || /\btee\b/.test(bare)) return "write";
  let kind: CommandKind = "read";
  for (const segment of bare.split(/&&|\|\||[;|&\n]/)) {
    const next = segmentKind(segment);
    if (RANK[next] > RANK[kind]) kind = next;
  }
  return kind;
}

export function isReadOnlyCommand(command: string): boolean {
  return commandKind(command) !== "write";
}
