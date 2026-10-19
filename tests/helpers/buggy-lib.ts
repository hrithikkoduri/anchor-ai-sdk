/**
 * The package's own end-to-end fixture: a tiny library with a seeded bug
 * (`add()` silently drops negative numbers). Scaffolded into a temp dir by
 * the suites that need it rather than read from a repo-root `fixtures/`
 * directory — so the package's tests are self-contained and run unchanged
 * from an extracted repository.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const FILES: Record<string, string> = {
  "package.json": `{
  "name": "buggy-lib",
  "version": "1.0.0",
  "private": true,
  "description": "A tiny fixture library with a seeded bug: add() silently drops negative numbers.",
  "scripts": {
    "test": "node test.js"
  }
}
`,
  "README.md": `# buggy-lib

A tiny fixture library used to exercise the coding agent end to end.

**The bug:** \`add()\` drops negative numbers — \`add(-1, -2)\` returns \`0\` instead of \`-3\`.

Run the tests with \`npm test\` (or \`node test.js\`).
`,
  "src/sum.js": `// buggy on purpose: negative numbers are silently dropped
function add(...numbers) {
  return numbers.filter((n) => n >= 0).reduce((a, b) => a + b, 0);
}

module.exports = { add };
`,
  "test.js": `const assert = require("node:assert");
const { add } = require("./src/sum");

assert.strictEqual(add(1, 2), 3, "adds positives");
assert.strictEqual(add(-1, -2), -3, "adds negatives");
assert.strictEqual(add(5, -2), 3, "adds mixed signs");
assert.strictEqual(add(0, 0), 0, "adds zeros");

console.log("all tests passed");
`,
};

/** Write the buggy-lib fixture into `rootDir` (created as needed). */
export async function scaffoldBuggyLib(rootDir: string): Promise<string> {
  for (const [name, content] of Object.entries(FILES)) {
    const file = path.join(rootDir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return rootDir;
}
