/*
 * Manual live LSP smoke test. This is intentionally not part of `npm test`:
 * language-server binaries and images are consumer configuration.
 *
 * Usage:
 *   npm run build
 *   PYRIGHT_LANGSERVER=/path/to/pyright-langserver \
 *   TYPESCRIPT_LANGUAGE_SERVER=/path/to/typescript-language-server \
 *   TSSERVER_PATH=/path/to/typescript/lib/tsserver.js \
 *   node scripts/lsp-live-smoke.mjs
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { local } from "../dist/sandbox/local/index.js";
import { PythonLsp, TypeScriptLsp, lspAllTools } from "../dist/lsp/index.js";

const pyright = process.env.PYRIGHT_LANGSERVER;
const tsls = process.env.TYPESCRIPT_LANGUAGE_SERVER;
const tsserver = process.env.TSSERVER_PATH;

if (!pyright && !tsls) {
  console.error(
    "Set PYRIGHT_LANGSERVER and/or TYPESCRIPT_LANGUAGE_SERVER to the server binaries.",
  );
  process.exit(2);
}

const root = await mkdtemp(path.join(os.tmpdir(), "anchor-lsp-live-"));
const box = local({ rootDir: root, quiet: true }).create({});
let failures = 0;

async function check(label, fn) {
  try {
    const value = await fn();
    const size = Array.isArray(value) ? `${value.length} item(s)` : "ok";
    console.log(`ok   ${label}: ${size}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Unhandled method|Method not found/i.test(message)) {
      console.log(`skip ${label}: ${message}`);
    } else {
      failures += 1;
      console.log(`FAIL ${label}: ${message}`);
    }
  }
}

await box.start();
try {
  await writeFile(
    path.join(box.workspace, "hello.py"),
    "def add(a: int, b: int) -> int:\n    return a + b\n\nvalue: int = 'wrong'\nadd(1, 'x')\n",
  );
  await writeFile(
    path.join(box.workspace, "hello.ts"),
    "function add(a: number, b: number): number { return a + b; }\nconst value: number = 'wrong';\nadd(1, 'x');\n",
  );

  if (pyright) {
    console.log(`\nPython: ${pyright}`);
    const client = new PythonLsp(box, {
      command: pyright,
      args: ["--stdio"],
      diagnosticsTimeoutMs: 15000,
      requestTimeoutMs: 15000,
    });
    try {
      await check("diagnostics", () => client.diagnostics("hello.py"));
      await check("hover", () => client.hover("hello.py", 2, 12));
      await check("completion", () => client.completion("hello.py", 5, 5));
      await check("signature", () => client.signatureHelp("hello.py", 5, 5));
      await check("symbols", () => client.symbols("hello.py"));
      await check("workspace symbols", () => client.workspaceSymbols("add"));
      await check("rename", () => client.rename("hello.py", 2, 5, "sum"));
    } finally {
      await client.close();
    }
  }

  if (tsls) {
    console.log(`\nTypeScript: ${tsls}`);
    if (!tsserver) {
      console.log(
        "skip TypeScript: set TSSERVER_PATH when the workspace has no local typescript package",
      );
    } else {
      const client = new TypeScriptLsp(box, {
        command: tsls,
        args: ["--stdio"],
        initializationOptions: { tsserver: { path: tsserver } },
        diagnosticsTimeoutMs: 15000,
        requestTimeoutMs: 15000,
      });
      try {
        await check("diagnostics", () => client.diagnostics("hello.ts"));
        await check("hover", () => client.hover("hello.ts", 1, 10));
        await check("completion", () => client.completion("hello.ts", 3, 5));
        await check("signature", () => client.signatureHelp("hello.ts", 3, 5));
        await check("symbols", () => client.symbols("hello.ts"));
        await check("workspace symbols", () => client.workspaceSymbols("add"));
        await check("format", () => client.formatting("hello.ts"));
        await check("rename", () => client.rename("hello.ts", 1, 10, "sum"));
        await check("folding", () => client.foldingRanges("hello.ts"));
      } finally {
        await client.close();
      }
    }
  }

  console.log(`\nfull tool count: ${lspAllTools.length}`);
  if (failures) {
    console.error(`\n${failures} live check(s) failed`);
    process.exitCode = 1;
  }
} finally {
  await box.destroy();
  await rm(root, { recursive: true, force: true });
}
