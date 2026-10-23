/**
 * The first LSP tools: diagnostics, definition, references, and document
 * symbols for TypeScript/JavaScript. They are optional and read-only; `search`
 * and `read_file` remain the fallback for other languages or when no language
 * server is installed.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Sandbox } from "../sandbox/types.js";
import { spillOrTruncate } from "../tools/truncate.js";
import {
  defineTool,
  optionalBoolean,
  optionalNumber,
  requireSandbox,
  requireString,
  type Tool,
  type ToolContext,
} from "../tools/types.js";
import {
  TypeScriptLsp,
  lspUriToPath,
  type LspDiagnostic,
  type LspLocation,
  type LspSymbol,
  type TypeScriptLspOptions,
} from "./typescript.js";

const sessions = new WeakMap<Sandbox, TypeScriptLsp>();

async function clientFor(
  ctx: ToolContext,
  opts: TypeScriptLspOptions,
): Promise<TypeScriptLsp> {
  const sandbox = requireSandbox(ctx);
  let client = sessions.get(sandbox);
  if (!client) {
    client = new TypeScriptLsp(sandbox, opts);
    sessions.set(sandbox, client);
  }
  try {
    await client.start();
  } catch (error) {
    sessions.delete(sandbox);
    throw error;
  }
  return client;
}

function displayPath(sandbox: Sandbox, uri: string): string {
  const file = lspUriToPath(uri);
  const relative = path.relative(sandbox.workspace, file);
  return relative && !relative.startsWith("..") ? relative : file;
}

function severityName(severity: number | undefined): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "diagnostic";
  }
}

function formatDiagnostic(
  sandbox: Sandbox,
  diagnostic: LspDiagnostic,
  uri: string,
): string {
  const line = diagnostic.range.start.line + 1;
  const column = diagnostic.range.start.character + 1;
  const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
  return `${displayPath(sandbox, uri)}:${line}:${column} ${severityName(diagnostic.severity)}: ${diagnostic.message}${code}`;
}

function formatLocation(sandbox: Sandbox, location: LspLocation): string {
  const line = location.range.start.line + 1;
  const column = location.range.start.character + 1;
  return `${displayPath(sandbox, location.uri)}:${line}:${column}`;
}

function formatSymbols(symbols: LspSymbol[], depth = 0): string[] {
  const indent = "  ".repeat(depth);
  return symbols.flatMap((symbol) => [
    `${indent}${symbol.name}${symbol.detail ? ` — ${symbol.detail}` : ""} (line ${symbol.range.start.line + 1})`,
    ...formatSymbols(symbol.children ?? [], depth + 1),
  ]);
}

export function createLspTools(
  opts: TypeScriptLspOptions = {},
): Tool[] {
  const diagnosticsTool = defineTool(
    {
      name: "lsp_diagnostics",
      description:
        "Get TypeScript/JavaScript errors and warnings for one file from the " +
        "language server. Use search/read_file for other languages or when no " +
        "language server is installed.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to the repo root, or absolute.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const file = requireString(input, "path");
      const client = await clientFor(ctx, opts);
      const diagnostics = await client.diagnostics(file);
      const sandbox = requireSandbox(ctx);
      const uri = pathToFileURL(client.resolvePath(file)).href;
      const lines = diagnostics.map((item) =>
        formatDiagnostic(sandbox, item, uri),
      );
      return {
        ok: true,
        content: await spillOrTruncate(
          lines.length
            ? `${lines.length} diagnostic(s) for ${file}:\n${lines.join("\n")}`
            : `no diagnostics for ${file}`,
          { sandbox, label: "lsp_diagnostics" },
        ),
        meta: { path: file, count: diagnostics.length },
      };
    },
    { readOnly: true, verb: "Checking TypeScript diagnostics" },
  );

  const definitionTool = defineTool(
    {
      name: "lsp_definition",
      description:
        "Find the definition of the TypeScript/JavaScript symbol at a 1-based " +
        "line and column. Falls back to search when no language server is available.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." },
          line: { type: "integer", description: "1-based line." },
          column: { type: "integer", description: "1-based column." },
        },
        required: ["path", "line", "column"],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const file = requireString(input, "path");
      const line = Math.max(1, Math.floor(optionalNumber(input, "line", 1)));
      const column = Math.max(1, Math.floor(optionalNumber(input, "column", 1)));
      const client = await clientFor(ctx, opts);
      const locations = await client.definition(file, line, column);
      const sandbox = requireSandbox(ctx);
      return {
        ok: true,
        content: await spillOrTruncate(
          locations.length
            ? `definition of ${file}:${line}:${column}:\n${locations.map((item) => formatLocation(sandbox, item)).join("\n")}`
            : `no definition found at ${file}:${line}:${column}`,
          { sandbox, label: "lsp_definition" },
        ),
        meta: { path: file, line, column, count: locations.length },
      };
    },
    { readOnly: true, verb: "Finding definition" },
  );

  const referencesTool = defineTool(
    {
      name: "lsp_references",
      description:
        "Find references to the TypeScript/JavaScript symbol at a 1-based line " +
        "and column. Falls back to search when no language server is available.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." },
          line: { type: "integer", description: "1-based line." },
          column: { type: "integer", description: "1-based column." },
          include_declaration: {
            type: "boolean",
            description: "Include the declaration itself (default true).",
          },
        },
        required: ["path", "line", "column"],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const file = requireString(input, "path");
      const line = Math.max(1, Math.floor(optionalNumber(input, "line", 1)));
      const column = Math.max(1, Math.floor(optionalNumber(input, "column", 1)));
      const includeDeclaration = optionalBoolean(input, "include_declaration") ?? true;
      const client = await clientFor(ctx, opts);
      const locations = await client.references(
        file,
        line,
        column,
        includeDeclaration,
      );
      const sandbox = requireSandbox(ctx);
      return {
        ok: true,
        content: await spillOrTruncate(
          locations.length
            ? `${locations.length} reference(s) to ${file}:${line}:${column}:\n${locations.map((item) => formatLocation(sandbox, item)).join("\n")}`
            : `no references found at ${file}:${line}:${column}`,
          { sandbox, label: "lsp_references" },
        ),
        meta: {
          path: file,
          line,
          column,
          includeDeclaration,
          count: locations.length,
        },
      };
    },
    { readOnly: true, verb: "Finding references" },
  );

  const symbolsTool = defineTool(
    {
      name: "lsp_symbols",
      description:
        "List TypeScript/JavaScript document symbols (classes, functions, " +
        "variables) for one file. Falls back to search when no language server " +
        "is available.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const file = requireString(input, "path");
      const client = await clientFor(ctx, opts);
      const symbols = await client.symbols(file);
      const sandbox = requireSandbox(ctx);
      const lines = formatSymbols(symbols);
      return {
        ok: true,
        content: await spillOrTruncate(
          lines.length
            ? `${lines.length} symbol(s) in ${file}:\n${lines.join("\n")}`
            : `no symbols found in ${file}`,
          { sandbox, label: "lsp_symbols" },
        ),
        meta: { path: file, count: symbols.length },
      };
    },
    { readOnly: true, verb: "Listing TypeScript symbols" },
  );

  return [diagnosticsTool, definitionTool, referencesTool, symbolsTool];
}

/** Default LSP tools for a sandbox image containing typescript-language-server. */
export const lspTools: Tool[] = createLspTools();
