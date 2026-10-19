import { describe, expect, it } from "vitest";
import { toolVerb } from "../../src/tools/activity.js";

describe("input-aware activity labels", () => {
  it.each([
    ["read_file", { path: "README.md" }, "Reading repository file README.md"],
    [
      "read_file",
      { path: "src/worker.ts", offset: 120 },
      "Reading src/worker.ts from line 120",
    ],
    [
      "edit_file",
      { path: "src/worker.ts" },
      "Updating matched code in src/worker.ts",
    ],
    [
      "search",
      { pattern: "processBatch", path: "src" },
      "Searching src for “processBatch”",
    ],
    ["run_tests", {}, "Running the repository test suite"],
    ["advance", { to: "verify" }, "Moving into the verify phase"],
    ["finish", {}, "Preparing the final task summary"],
    ["finish", { success: false }, "Recording why work stopped"],
  ])("describes %s using its inputs", (name, input, expected) => {
    expect(toolVerb(name, input)).toBe(expected);
  });

  it.each([
    ["git status --short", "Checking repository working tree status"],
    [
      "cd '/workspace/my repo' && git diff --stat",
      "Reviewing the repository code diff",
    ],
    [
      "git -C /workspace/repo log -5",
      "Reviewing recent repository commit history",
    ],
    [
      "echo '=== diff ==='; git diff --stat",
      "Reviewing the repository code diff",
    ],
    [
      "timeout 30 curl -s https://example.com",
      "Sending an HTTP network request",
    ],
    [
      "python3 - <<'PY'\nprint('git diff')\nPY",
      "Running an inline Python script",
    ],
    ["python scripts/check.py", "Running Python script scripts/check.py"],
    ["python3 -m json.tool package.json", "Running Python module json.tool"],
    ["python3 --version", "Checking the installed Python version"],
    ["python -c 'private_code.py'", "Running an inline Python script"],
    ["node -e 'console.log(1)'", "Running inline JavaScript with Node"],
    ["npm run test:unit", "Running the unit test suite"],
    ["npm run test:integration", "Running the integration test suite"],
    ["pnpm test", "Running the project test suite"],
    ["npx playwright test", "Running the browser test suite"],
    ["npm run build", "Building the project production bundle"],
    ["npm run typecheck", "Checking the project TypeScript types"],
    ["env CI=1 npm ci", "Installing the project package dependencies"],
    [
      "curl -H 'Authorization: Bearer secret-token' https://example.com",
      "Sending an HTTP network request",
    ],
    [
      "custom-tool --token secret-token",
      "Running repository command: custom-tool",
    ],
  ])(
    "summarizes %s without showing raw shell arguments",
    (command, expected) => {
      expect(toolVerb("bash", { command })).toBe(expected);
    },
  );

  it("preserves developer-defined verbs and safely falls back if they throw", () => {
    expect(
      toolVerb("bash", {}, "Inspecting the dataset boundary conditions"),
    ).toBe("Inspecting the dataset boundary conditions");
    expect(
      toolVerb(
        "lookup",
        { key: "settings" },
        (input) => `Looking up ${input.key}`,
      ),
    ).toBe("Looking up settings");
    expect(
      toolVerb("bash", { command: "git diff" }, () => {
        throw new Error("bad label");
      }),
    ).toBe("Reviewing the repository code diff");
  });

  it("bounds text, normalizes whitespace, and tolerates missing/invalid input", () => {
    expect(toolVerb("search", { pattern: "one\ntwo\tthree" })).toBe(
      "Searching repository for “one two three”",
    );
    expect(
      toolVerb("search", {
        pattern: "x".repeat(10000),
        path: "a".repeat(10000),
      }).length,
    ).toBeLessThanOrEqual(160);
    expect(toolVerb("bash", { command: 42 })).toBe(
      "Executing a repository shell command",
    );
  });
});
