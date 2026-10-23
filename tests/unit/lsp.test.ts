import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { local } from "../../src/sandbox/local/index.js";
import { encodeLspMessage, LspFramer } from "../../src/lsp/protocol.js";
import { TypeScriptLsp } from "../../src/lsp/typescript.js";
import { PythonLsp, pythonLanguageServer } from "../../src/lsp/python.js";
import { createLspTools } from "../../src/lsp/tools.js";
import type { Sandbox } from "../../src/sandbox/types.js";

const roots: string[] = [];
const fixture = fileURLToPath(
  new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "anchor-lsp-"));
  roots.push(root);
  const box = local({ rootDir: root, quiet: true }).create({});
  await box.start();
  return box;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("LSP framing", () => {
  it("parses split frames and concatenated frames", () => {
    const one = encodeLspMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const two = encodeLspMessage({ jsonrpc: "2.0", method: "ready" });
    const stream = Buffer.concat([one, two]);
    const framer = new LspFramer();
    expect(framer.push(stream.subarray(0, 7))).toEqual([]);
    expect(framer.push(stream.subarray(7, 20))).toEqual([]);
    expect(framer.push(stream.subarray(20))).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", method: "ready" },
    ]);
  });
});

describe("TypeScript LSP", () => {
  it("initializes and serves diagnostics, definitions, references, and symbols", async () => {
    const box = await sandbox();
    await writeFile(path.join(box.workspace, "index.ts"), "const value = 1;\n");
    const client = new TypeScriptLsp(box, {
      command: "node",
      args: [fixture],
      diagnosticsTimeoutMs: 2000,
    });
    try {
      await client.start();
      expect(await client.diagnostics("index.ts")).toMatchObject([
        { severity: 1, message: "fixture diagnostic" },
      ]);
      expect(await client.definition("index.ts", 1, 7)).toHaveLength(1);
      expect(await client.references("index.ts", 1, 7)).toHaveLength(1);
      expect(await client.symbols("index.ts")).toMatchObject([
        { name: "fixtureSymbol" },
      ]);
    } finally {
      await client.close();
      await box.destroy();
    }
  });

  it("declares the four optional tools", () => {
    expect(createLspTools().map((tool) => tool.definition.name)).toEqual([
      "lsp_diagnostics",
      "lsp_definition",
      "lsp_references",
      "lsp_symbols",
    ]);
  });
  it("runs the Python preset and selects it by extension", async () => {
    const box = await sandbox();
    try {
      await writeFile(path.join(box.workspace, "main.py"), "print('hello')\n");
      const python = new PythonLsp(box, {
        command: "node",
        args: [fixture],
        diagnosticsTimeoutMs: 2000,
      });
      try {
        expect(await python.diagnostics("main.py")).toMatchObject([
          { severity: 1, message: "fixture diagnostic" },
        ]);
      } finally {
        await python.close();
      }

      const tools = createLspTools({
        servers: [
          pythonLanguageServer({
            command: "node",
            args: [fixture],
            diagnosticsTimeoutMs: 2000,
          }),
        ],
      });
      const result = await tools[0]!.run({ path: "main.py" }, { sandbox: box });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("fixture diagnostic");

      const unsupported = await tools[0]!.run(
        { path: "main.rb" },
        { sandbox: box },
      );
      expect(unsupported.ok).toBe(false);
      expect(unsupported.content).toContain(".py");
    } finally {
      await box.destroy();
    }
  });
});
