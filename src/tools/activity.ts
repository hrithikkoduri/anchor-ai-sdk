import type { Tool } from "./types.js";

/** Short, input-aware activity labels. These describe the operation, not an
 * invented intent or successful outcome. No model call or shell execution. */
export function toolVerb(
  name: string,
  input: Record<string, unknown>,
  custom?: Tool["verb"],
): string {
  try {
    const configured = typeof custom === "function" ? custom(input) : custom;
    if (configured?.trim()) return configured.trim().slice(0, 160);
  } catch {
    /* display metadata must never break tool execution */
  }
  const path = text(input.path, 90);
  switch (name) {
    case "read_file":
      return path
        ? typeof input.offset === "number" && input.offset > 1
          ? `Reading ${path} from line ${input.offset}`
          : `Reading repository file ${path}`
        : "Reading a repository source file";
    case "edit_file":
      return path
        ? `Updating matched code in ${path}`
        : "Updating a repository source file";
    case "search": {
      const pattern = text(input.pattern, 48);
      return pattern
        ? `Searching ${path && path !== "." ? path : "repository"} for “${pattern}”`
        : "Searching for matching repository code";
    }
    case "bash":
      return commandVerb(input.command);
    case "run_tests":
      return input.command
        ? commandVerb(input.command)
        : "Running the repository test suite";
    case "advance":
      return input.to
        ? `Moving into the ${text(input.to, 40)} phase`
        : "Moving into the next phase";
    case "finish":
      return input.success === false
        ? "Recording why work stopped"
        : "Preparing the final task summary";
    default:
      return `Running the ${text(name.replace(/_/g, " "), 90)} tool`;
  }
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Read just the leading command, respecting quoted arguments. Skip common
 * working-directory/env setup; never inspect script bodies or print raw shell
 * snippets (which can contain credentials). This is deliberately not a parser. */
function commandVerb(value: unknown): string {
  const command =
    typeof value === "string"
      ? value.trim().split(/\r?\n/, 1)[0]!.slice(0, 1000)
      : "";
  const words =
    command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|[;|<>]|[^\s;|<>]+/g) ?? [];
  let start = 0;
  while (["cd", "export", "echo", "printf"].includes(words[start] ?? "")) {
    const end = words.findIndex(
      (word, i) => i > start && ["&&", ";"].includes(word),
    );
    if (end < 0)
      return ["echo", "printf"].includes(words[start]!)
        ? "Printing shell output for inspection"
        : "Preparing the repository shell environment";
    start = end + 1;
  }
  if (words[start] === "env") start++;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? "")) start++;
  if (["timeout", "gtimeout"].includes(words[start] ?? "")) {
    start++;
    while (words[start]?.startsWith("-")) {
      if (["-k", "--kill-after", "-s", "--signal"].includes(words[start]!))
        start++;
      start++;
    }
    if (/^\d+(?:\.\d+)?[smhd]?$/.test(words[start] ?? "")) start++;
  }
  const args = words
    .slice(start)
    .map((word) => word.replace(/^(["'])(.*)\1$/, "$2"));
  const exe = args.shift()?.split("/").at(-1) ?? "";
  const tail = args.join(" ");
  const scriptFile = args.find(
    (arg) => !arg.startsWith("-") && /\.(?:py|[cm]?js|tsx?)$/.test(arg),
  );

  if (/^python(?:\d(?:\.\d+)?)?$/.test(exe)) {
    if (args[0] === "-m" && args[1] === "pytest")
      return "Running repository tests with pytest";
    if (args[0] === "-m" && args[1] === "pip" && args[2] === "install")
      return "Installing the Python project dependencies";
    if (args[0] === "-m" && /^[\w.]+$/.test(args[1] ?? ""))
      return `Running Python module ${text(args[1], 90)}`;
    if (args.includes("--version") || args.includes("-V"))
      return "Checking the installed Python version";
    if (args.includes("-c") || args.includes("-"))
      return "Running an inline Python script";
    return scriptFile
      ? `Running Python script ${text(scriptFile, 90)}`
      : "Running an inline Python script";
  }
  if (exe === "node")
    return !args.some((arg) =>
      ["-e", "--eval", "-p", "--print", "-"].includes(arg),
    ) && scriptFile
      ? `Running JavaScript script ${text(scriptFile, 90)}`
      : "Running inline JavaScript with Node";
  if (exe === "git") {
    const operation = args[0] === "-C" ? args[2] : args[0];
    const labels: Record<string, string> = {
      status: "Checking repository working tree status",
      diff: "Reviewing the repository code diff",
      log: "Reviewing recent repository commit history",
      show: "Inspecting a repository Git object",
      "ls-files": "Listing files tracked by Git",
      grep: "Searching tracked repository text",
    };
    return labels[operation ?? ""] ?? "Running a repository Git command";
  }
  if (["npm", "pnpm", "yarn", "bun", "npx"].includes(exe)) {
    if (["install", "ci", "add"].includes(args[0] ?? ""))
      return "Installing the project package dependencies";
    const script = ["run", "exec", "x"].includes(args[0] ?? "")
      ? args[1]
      : args[0];
    if (/^(?:test|vitest|jest|playwright)(?:$|:)/.test(script ?? "")) {
      if (/(?:^|[:/-])unit\b/.test(tail)) return "Running the unit test suite";
      if (/(?:^|[:/-])integration\b/.test(tail))
        return "Running the integration test suite";
      if (/(?:^|[:/-])(?:ui|e2e)\b/.test(tail) || script === "playwright")
        return "Running the browser test suite";
      return "Running the project test suite";
    }
    if (script === "build") return "Building the project production bundle";
    if (["typecheck", "tsc"].includes(script ?? ""))
      return script === "tsc" && !args.includes("--noEmit")
        ? "Compiling the TypeScript project sources"
        : "Checking the project TypeScript types";
    if (["lint", "eslint"].includes(script ?? ""))
      return "Checking the project lint rules";
    if (script && /^[\w:.-]+$/.test(script))
      return `Running project ${exe === "npx" ? "tool" : "script"} ${text(script, 70)}`;
  }
  const labels: Record<string, string> = {
    ls: "Listing files in the repository",
    find: "Finding files in the repository",
    rg: "Searching repository code with ripgrep",
    grep: "Searching repository text with grep",
    cat: "Reading file contents with cat",
    head: "Reading the opening file lines",
    tail: "Reading the latest file lines",
    sed: "Processing repository text with sed",
    pytest: "Running repository tests with pytest",
    curl: "Sending an HTTP network request",
    for: "Running a shell loop",
  };
  return (
    labels[exe] ??
    (/^[\w.-]+$/.test(exe)
      ? `Running repository command: ${text(exe, 70)}`
      : "Executing a repository shell command")
  );
}
