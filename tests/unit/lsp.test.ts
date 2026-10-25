import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { local } from "../../src/sandbox/local/index.js";
import { encodeLspMessage, LspFramer } from "../../src/lsp/protocol.js";
import { TypeScriptLsp, typescriptLanguageServer } from "../../src/lsp/typescript.js";
import { PythonLsp, pythonLanguageServer } from "../../src/lsp/python.js";
import { closeLspSessions, createLspTools, lspAllTools } from "../../src/lsp/tools.js";
import { scopedSandbox } from "../../src/sandbox/scoped.js";
import { execSync } from "node:child_process";
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
  it("serves the common advanced editor features", async () => {
    const box = await sandbox();
    try {
      await writeFile(path.join(box.workspace, "index.ts"), "const value = 1;\n");
      const client = new TypeScriptLsp(box, {
        command: "node",
        args: [fixture],
        diagnosticsTimeoutMs: 2000,
      });
      try {
        expect(await client.hover("index.ts", 1, 7)).toMatchObject({
          contents: "**fixture hover**",
        });
        expect(await client.completion("index.ts", 1, 7)).toMatchObject([
          { label: "fixtureCompletion", documentation: "fixture docs" },
        ]);
        expect(await client.signatureHelp("index.ts", 1, 7)).toMatchObject({
          signatures: [{ label: "fixture(value: string)" }],
        });
        expect(await client.documentHighlights("index.ts", 1, 7)).toHaveLength(1);
        expect(await client.codeActions("index.ts", 1, 1, 1, 2)).toMatchObject([
          { title: "fixture action", isPreferred: true },
        ]);
        expect(await client.workspaceSymbols("fixture")).toMatchObject([
          { name: "fixtureWorkspaceSymbol" },
        ]);
        expect(await client.formatting("index.ts")).toMatchObject([
          { newText: "formatted" },
        ]);
        expect(await client.rangeFormatting("index.ts", 1, 1, 1, 2)).toMatchObject([
          { newText: "range-formatted" },
        ]);
        expect(await client.rename("index.ts", 1, 7, "renamed")).toMatchObject({
          changes: { [new URL(`file://${path.join(box.workspace, "index.ts")}`).href]: [{ newText: "renamed" }] },
        });
        expect(await client.foldingRanges("index.ts")).toMatchObject([
          { startLine: 0, endLine: 2 },
        ]);
        expect(await client.inlayHints("index.ts")).toMatchObject([
          { label: ": number" },
        ]);
        expect(await client.typeDefinition("index.ts", 1, 7)).toHaveLength(1);
        expect(await client.implementation("index.ts", 1, 7)).toHaveLength(1);
        expect(await client.declaration("index.ts", 1, 7)).toHaveLength(1);
      } finally {
        await client.close();
      }
    } finally {
      await box.destroy();
    }
  });

  it("exposes the full tool set only when requested", () => {
    expect(createLspTools({ features: ["hover"] }).map((tool) => tool.definition.name)).toContain(
      "lsp_hover",
    );
    expect(lspAllTools.map((tool) => tool.definition.name)).toEqual(
      expect.arrayContaining([
        "lsp_hover",
        "lsp_completion",
        "lsp_signature_help",
        "lsp_code_actions",
        "lsp_format",
        "lsp_rename",
      ]),
    );
  });

  it("runs advanced tools through the extension-selected client", async () => {
    const box = await sandbox();
    try {
      await writeFile(path.join(box.workspace, "index.ts"), "const value = 1;\n");
      const tools = createLspTools({
        servers: [
          typescriptLanguageServer({
            command: "node",
            args: [fixture],
            diagnosticsTimeoutMs: 2000,
          }),
        ],
        features: ["hover", "format"],
      });
      const hover = tools.find(
        (tool) => tool.definition.name === "lsp_hover",
      )!;
      const hoverResult = await hover.run(
        { path: "index.ts", line: 1, column: 7 },
        { sandbox: box },
      );
      expect(hoverResult.ok).toBe(true);
      expect(hoverResult.content).toContain("fixture hover");

      const format = tools.find(
        (tool) => tool.definition.name === "lsp_format",
      )!;
      const formatResult = await format.run(
        { path: "index.ts" },
        { sandbox: box },
      );
      expect(formatResult.ok).toBe(true);
      expect(formatResult.content).toContain("not applied");
    } finally {
      await box.destroy();
    }
  });


  it("one server per sandbox object; closeLspSessions stops it, and a view's servers are its own", async () => {
    const box = await sandbox();
    // Count only this test's servers: the fixture runs with the sandbox's path in its cwd-free args, so match on a marker.
    const marker = `lsp-close-${Date.now()}`;
    const running = () =>
      Number(execSync(`ps -eo args | grep -F -- ${JSON.stringify(marker)} | grep -v grep | wc -l`).toString().trim());
    try {
      await writeFile(path.join(box.workspace, "index.ts"), "const value = 1;\n");
      await import("node:fs/promises").then((fs) => fs.mkdir(path.join(box.workspace, "tree"), { recursive: true }));
      await writeFile(path.join(box.workspace, "tree", "index.ts"), "const value = 1;\n");
      const [diagnostics] = createLspTools({
        servers: [typescriptLanguageServer({ command: "node", args: [fixture, marker], diagnosticsTimeoutMs: 2000 })],
      }).filter((tool) => tool.definition.name === "lsp_diagnostics");
      const ask = (where: Sandbox) => diagnostics!.run({ path: "index.ts" }, { sandbox: where });

      expect((await ask(box)).ok).toBe(true);
      expect((await ask(box)).ok).toBe(true);
      expect(running()).toBe(1); // reused, not restarted

      const view = scopedSandbox(box, "tree");
      expect((await ask(view)).ok).toBe(true);
      expect(running()).toBe(2); // a different tree, a different server

      expect(await closeLspSessions(view)).toBe(1);
      await expect.poll(running).toBe(1); // only the view's server stopped
      expect(await closeLspSessions(box)).toBe(1);
      await expect.poll(running).toBe(0);
      expect(await closeLspSessions(box)).toBe(0);

      expect((await ask(box)).ok).toBe(true); // starts fresh after a close
      expect(running()).toBe(1);
      await closeLspSessions(box);
    } finally {
      await box.destroy();
    }
  });
});
