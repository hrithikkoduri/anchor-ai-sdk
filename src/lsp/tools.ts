/**
 * Generic LSP tools: diagnostics, definition, references, and document
 * symbols for whatever server definitions the consumer supplies. They are
 * optional and read-only; `search` and `read_file` remain the fallback when no
 * language server is installed.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoCwd, repoForPath, type RepoRef } from "../repo.js";
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
  LspServer,
  lspUriToPath,
  type LspCodeAction,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspDocumentHighlight,
  type LspFoldingRange,
  type LspHover,
  type LspInlayHint,
  type LspLocation,
  type LspServerConfig,
  type LspSignatureHelp,
  type LspSymbol,
  type LspTextEdit,
  type LspWorkspaceEdit,
  type LspWorkspaceSymbol,
} from "./server.js";
import { typescriptLanguageServer, type TypeScriptLspOptions } from "./typescript.js";

export type LspToolFeature =
  | "hover"
  | "completion"
  | "signature_help"
  | "document_highlights"
  | "code_actions"
  | "workspace_symbols"
  | "format"
  | "rename"
  | "folding_ranges"
  | "inlay_hints"
  | "type_definition"
  | "implementation"
  | "declaration";

export interface LspToolsOptions extends TypeScriptLspOptions {
  /** One or more language servers; defaults to the TypeScript/JavaScript preset. */
  servers?: LspServerConfig[];
  /** Peer repositories; server roots are selected by file path. */
  repos?: RepoRef[];
  /**
   * Core is always included. Add extra read-only tools with an array, or use
   * `"all"` for the full common editor surface. `format`/`rename` return edits;
   * they do not write files.
   */
  features?: "all" | LspToolFeature[];
}

export { configsForRepo };

const sessions = new WeakMap<Sandbox, Map<string, LspServer>>();

async function clientForConfig(
  ctx: ToolContext,
  config: LspServerConfig,
): Promise<LspServer> {
  const sandbox = requireSandbox(ctx);
  let byId = sessions.get(sandbox);
  if (!byId) {
    byId = new Map();
    sessions.set(sandbox, byId);
  }
  let client = byId.get(config.id);
  if (!client) {
    client = new LspServer(sandbox, config);
    byId.set(config.id, client);
  }
  try {
    await client.start();
  } catch (error) {
    byId.delete(config.id);
    throw error;
  }
  return client;
}

/**
 * Start the language servers an agent is about to use and have each load its
 * project, before its first call — so the load overlaps whatever it does
 * first. A server loads a project when a file in it is opened, so warming opens
 * one file per project. It shares the tools' sessions (same sandbox object,
 * same server ids): the agent's first call finds the server warm. Best-effort:
 * a file that cannot be opened is skipped. Returns how many files were opened.
 */
export async function warmLspSessions(
  sandbox: Sandbox,
  options: { servers: LspServerConfig[]; repos?: RepoRef[]; files: readonly string[] },
): Promise<number> {
  const ctx = { sandbox, ...(options.repos ? { repos: options.repos } : {}) } as ToolContext;
  const opened = await Promise.all(
    options.files.map(async (file) => {
      try {
        const client = await clientFor(ctx, file, options.servers, options.repos);
        await client.openDocument(file);
        return true;
      } catch {
        return false;
      }
    }),
  );
  return opened.filter(Boolean).length;
}

/**
 * Stop every language server started for this sandbox (or sandbox view) and
 * forget them; the next LSP call starts fresh. Servers live as long as the
 * sandbox object they were started for, so a consumer that is done with a
 * sandbox — a run that ended, a worker's tree it will not use again — calls
 * this, or the processes keep running inside the sandbox. Returns how many
 * servers were stopped.
 */
export async function closeLspSessions(sandbox: Sandbox): Promise<number> {
  const byId = sessions.get(sandbox);
  if (!byId) return 0;
  sessions.delete(sandbox);
  const servers = [...byId.values()];
  await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
  return servers.length;
}

function configsForRepo(
  servers: LspServerConfig[],
  repo: RepoRef | undefined,
  workspace: string,
): LspServerConfig[] {
  if (!repo) return servers;
  const rootUri = pathToFileURL(repoCwd(workspace, repo)).href;
  return servers.map((server) => ({
    ...server,
    id: `${server.id}:${repo.name}`,
    rootUri,
  }));
}

async function clientFor(
  ctx: ToolContext,
  file: string,
  servers: LspServerConfig[],
  repos?: RepoRef[],
): Promise<LspServer> {
  const sandbox = requireSandbox(ctx);
  const repo = repoForPath(
    repos ?? ctx.repos,
    file,
    sandbox.workspace,
  );
  const active = configsForRepo(servers, repo, sandbox.workspace);
  const extension = path.extname(file).toLowerCase();
  const config = active.find((server) => server.languageIds[extension]);
  if (!config) {
    const supported = [...new Set(servers.flatMap((server) => Object.keys(server.languageIds)))];
    throw new Error(
      `no language server is configured for ${extension || "this file"}; supported extensions: ${supported.join(", ")}`,
    );
  }
  return clientForConfig(ctx, config);
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

function formatHover(hover: LspHover | null): string {
  if (!hover) return "no hover information";
  const range = hover.range
    ? ` (range ${hover.range.start.line + 1}:${hover.range.start.character + 1}-${hover.range.end.line + 1}:${hover.range.end.character + 1})`
    : "";
  return `${hover.contents}${range}`;
}

function formatCompletion(
  items: LspCompletionItem[],
  limit = 40,
): string {
  if (!items.length) return "no completion items";
  const shown = items.slice(0, limit);
  const lines = shown.map((item) => {
    const detail = item.detail ? ` — ${item.detail}` : "";
    const docs = item.documentation
      ? `\n  ${item.documentation.split("\n")[0]}`
      : "";
    const deprecated = item.deprecated ? " (deprecated)" : "";
    return `${item.label}${detail}${deprecated}${docs}`;
  });
  const suffix =
    items.length > shown.length
      ? `\n... ${items.length - shown.length} more item(s)`
      : "";
  return `${items.length} completion item(s):\n${lines.join("\n")}${suffix}`;
}

function formatSignatureHelp(help: LspSignatureHelp | null): string {
  if (!help) return "no signature help";
  const active = help.signatures[help.activeSignature ?? 0] ?? help.signatures[0];
  if (!active) return "no signature help";
  const parameters = active.parameters ?? [];
  const lines = parameters.map((parameter, index) => {
    const marker = index === help.activeParameter ? ">" : " ";
    const docs = parameter.documentation
      ? ` — ${parameter.documentation}`
      : "";
    return `${marker} ${index + 1}. ${parameter.label}${docs}`;
  });
  return [
    active.label,
    ...(active.documentation ? [active.documentation] : []),
    ...lines,
  ].join("\n");
}

function formatTextEdits(
  sandbox: Sandbox,
  uri: string,
  edits: LspTextEdit[],
): string[] {
  return edits.map((edit) => {
    const start = edit.range.start;
    const end = edit.range.end;
    const text = edit.newText.replaceAll("\n", "\\n");
    return `${displayPath(sandbox, uri)}:${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1} -> ${text}`;
  });
}

function formatWorkspaceEdit(
  sandbox: Sandbox,
  edit: LspWorkspaceEdit,
): string[] {
  const lines: string[] = [];
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    lines.push(...formatTextEdits(sandbox, uri, edits));
  }
  if (edit.documentChanges?.length) {
    lines.push(
      `${edit.documentChanges.length} documentChange(s) returned; inspect them with LspServer.request()`,
    );
  }
  return lines.length ? lines : ["no edits returned"];
}

function formatWorkspaceSymbols(
  sandbox: Sandbox,
  symbols: LspWorkspaceSymbol[],
  limit = 50,
): string {
  if (!symbols.length) return "no workspace symbols";
  const shown = symbols.slice(0, limit);
  const lines = shown.map((symbol) => {
    const container = symbol.containerName
      ? ` in ${symbol.containerName}`
      : "";
    const location = symbol.location
      ? ` at ${displayPath(sandbox, symbol.location.uri)}:${symbol.location.range.start.line + 1}:${symbol.location.range.start.character + 1}`
      : "";
    return `${symbol.name}${container} (kind ${symbol.kind})${location}`;
  });
  const suffix =
    symbols.length > shown.length
      ? `\n... ${symbols.length - shown.length} more symbol(s)`
      : "";
  return `${symbols.length} workspace symbol(s):\n${lines.join("\n")}${suffix}`;
}

function formatCodeActions(actions: LspCodeAction[]): string {
  if (!actions.length) return "no code actions";
  return `${actions.length} code action(s):\n${actions
    .map((action) => {
      const kind = action.kind ? ` [${action.kind}]` : "";
      const preferred = action.isPreferred ? " (preferred)" : "";
      const disabled = action.disabled ? ` (disabled: ${action.disabled})` : "";
      const edit = action.edit !== undefined ? " [has edits]" : "";
      const command = action.command !== undefined ? " [has command]" : "";
      return `${action.title}${kind}${preferred}${disabled}${edit}${command}`;
    })
    .join("\n")}`;
}

function formatHighlights(highlights: LspDocumentHighlight[]): string {
  if (!highlights.length) return "no document highlights";
  return `${highlights.length} highlight(s):\n${highlights
    .map(
      (highlight) =>
        `${highlight.range.start.line + 1}:${highlight.range.start.character + 1}-${highlight.range.end.line + 1}:${highlight.range.end.character + 1}${highlight.kind ? ` (kind ${highlight.kind})` : ""}`,
    )
    .join("\n")}`;
}

function formatFoldingRanges(ranges: LspFoldingRange[]): string {
  if (!ranges.length) return "no folding ranges";
  return `${ranges.length} folding range(s):\n${ranges
    .map(
      (range) =>
        `${range.startLine + 1}-${range.endLine + 1}${range.kind ? ` (${range.kind})` : ""}${range.collapsedText ? `: ${range.collapsedText}` : ""}`,
    )
    .join("\n")}`;
}

function formatInlayHints(hints: LspInlayHint[]): string {
  if (!hints.length) return "no inlay hints";
  return `${hints.length} inlay hint(s):\n${hints
    .map(
      (hint) =>
        `${hint.position.line + 1}:${hint.position.character + 1} ${hint.label}${hint.tooltip ? ` — ${hint.tooltip}` : ""}`,
    )
    .join("\n")}`;
}

export function createLspTools(opts: LspToolsOptions = {}): Tool[] {
  const servers = opts.servers ?? [typescriptLanguageServer(opts)];
  const repos = opts.repos;
  const diagnosticsTool = defineTool(
    {
      name: "lsp_diagnostics",
      description:
        "Get errors and warnings for one file from the configured language " +
        "server. Use search/read_file when no server is configured or installed.",
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
      const client = await clientFor(ctx, file, servers, repos);
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
    { readOnly: true, verb: "Checking diagnostics" },
  );

  const definitionTool = defineTool(
    {
      name: "lsp_definition",
      description:
        "Find the definition of the symbol at a 1-based line and column. " +
        "Falls back to search when no language server is available.",
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
      const client = await clientFor(ctx, file, servers, repos);
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
        "Find references to the symbol at a 1-based line and column. Falls " +
        "back to search when no language server is available.",
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
      const client = await clientFor(ctx, file, servers, repos);
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
        "List document symbols (classes, functions, variables) for one file. " +
        "Falls back to search when no language server is available.",
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
      const client = await clientFor(ctx, file, servers, repos);
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

  const core = [diagnosticsTool, definitionTool, referencesTool, symbolsTool];
  const features =
    opts.features === "all" ? [...ALL_LSP_FEATURES] : (opts.features ?? []);
  return [...core, ...createAdvancedLspTools(servers, opts.repos, features)];
}

const ALL_LSP_FEATURES: LspToolFeature[] = [
  "hover",
  "completion",
  "signature_help",
  "document_highlights",
  "code_actions",
  "workspace_symbols",
  "format",
  "rename",
  "folding_ranges",
  "inlay_hints",
  "type_definition",
  "implementation",
  "declaration",
];

function createAdvancedLspTools(
  servers: LspServerConfig[],
  repos: RepoRef[] | undefined,
  features: LspToolFeature[],
): Tool[] {
  const enabled = new Set(features);
  const tools: Tool[] = [];
  const add = (feature: LspToolFeature): boolean => enabled.has(feature);

  if (add("hover")) {
    tools.push(
      defineTool(
        {
          name: "lsp_hover",
          description:
            "Get hover/type information and documentation for the symbol at a " +
            "1-based line and column.",
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
          const column = Math.max(
            1,
            Math.floor(optionalNumber(input, "column", 1)),
          );
          const client = await clientFor(ctx, file, servers, repos);
          const hover = await client.hover(file, line, column);
          return {
            ok: true,
            content: `hover for ${file}:${line}:${column}:\n${formatHover(hover)}`,
            meta: { path: file, line, column, found: hover !== null },
          };
        },
        { readOnly: true, verb: "Looking up hover information" },
      ),
    );
  }

  if (add("completion")) {
    tools.push(
      defineTool(
        {
          name: "lsp_completion",
          description:
            "List completion candidates at a 1-based line and column. Use a " +
            "trigger character such as '.' when the server needs one.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path." },
              line: { type: "integer", description: "1-based line." },
              column: { type: "integer", description: "1-based column." },
              trigger_character: {
                type: "string",
                description: "Optional completion trigger character.",
              },
              limit: {
                type: "integer",
                description: "Maximum number of items to show (default 40).",
              },
            },
            required: ["path", "line", "column"],
            additionalProperties: false,
          },
        },
        async (input, ctx) => {
          const file = requireString(input, "path");
          const line = Math.max(1, Math.floor(optionalNumber(input, "line", 1)));
          const column = Math.max(
            1,
            Math.floor(optionalNumber(input, "column", 1)),
          );
          const limit = Math.max(
            1,
            Math.floor(optionalNumber(input, "limit", 40)),
          );
          const trigger =
            typeof input.trigger_character === "string"
              ? input.trigger_character
              : undefined;
          const client = await clientFor(ctx, file, servers, repos);
          const items = await client.completion(
            file,
            line,
            column,
            trigger,
          );
          return {
            ok: true,
            content: formatCompletion(items, limit),
            meta: { path: file, line, column, count: items.length },
          };
        },
        { readOnly: true, verb: "Listing completion candidates" },
      ),
    );
  }

  if (add("signature_help")) {
    tools.push(
      defineTool(
        {
          name: "lsp_signature_help",
          description:
            "Get call-signature help at a 1-based line and column, including " +
            "the active parameter when the server reports it.",
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
          const column = Math.max(
            1,
            Math.floor(optionalNumber(input, "column", 1)),
          );
          const client = await clientFor(ctx, file, servers, repos);
          const help = await client.signatureHelp(file, line, column);
          return {
            ok: true,
            content: `signature help for ${file}:${line}:${column}:\n${formatSignatureHelp(help)}`,
            meta: { path: file, line, column, found: help !== null },
          };
        },
        { readOnly: true, verb: "Looking up signature help" },
      ),
    );
  }

  if (add("document_highlights")) {
    tools.push(
      defineTool(
        {
          name: "lsp_document_highlights",
          description:
            "Highlight all occurrences of the symbol at a 1-based line and column.",
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
          const column = Math.max(
            1,
            Math.floor(optionalNumber(input, "column", 1)),
          );
          const client = await clientFor(ctx, file, servers, repos);
          const highlights = await client.documentHighlights(
            file,
            line,
            column,
          );
          return {
            ok: true,
            content: `${file}:${line}:${column}\n${formatHighlights(highlights)}`,
            meta: { path: file, line, column, count: highlights.length },
          };
        },
        { readOnly: true, verb: "Highlighting symbol occurrences" },
      ),
    );
  }

  if (add("code_actions")) {
    tools.push(
      defineTool(
        {
          name: "lsp_code_actions",
          description:
            "List quick fixes and refactors for a range. Returns action " +
            "metadata and edits; it does not apply them.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path." },
              start_line: { type: "integer", description: "1-based start line." },
              start_column: {
                type: "integer",
                description: "1-based start column.",
              },
              end_line: { type: "integer", description: "1-based end line." },
              end_column: { type: "integer", description: "1-based end column." },
            },
            required: [
              "path",
              "start_line",
              "start_column",
              "end_line",
              "end_column",
            ],
            additionalProperties: false,
          },
        },
        async (input, ctx) => {
          const file = requireString(input, "path");
          const startLine = Math.max(
            1,
            Math.floor(optionalNumber(input, "start_line", 1)),
          );
          const startColumn = Math.max(
            1,
            Math.floor(optionalNumber(input, "start_column", 1)),
          );
          const endLine = Math.max(
            startLine,
            Math.floor(optionalNumber(input, "end_line", startLine)),
          );
          const endColumn = Math.max(
            1,
            Math.floor(optionalNumber(input, "end_column", startColumn)),
          );
          const client = await clientFor(ctx, file, servers, repos);
          const actions = await client.codeActions(
            file,
            startLine,
            startColumn,
            endLine,
            endColumn,
          );
          return {
            ok: true,
            content: formatCodeActions(actions),
            meta: { path: file, count: actions.length, applied: false },
          };
        },
        { readOnly: true, verb: "Listing code actions" },
      ),
    );
  }

  if (add("workspace_symbols")) {
    tools.push(
      defineTool(
        {
          name: "lsp_workspace_symbols",
          description:
            "Search workspace symbols by name, returning their locations.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Symbol name or query; empty lists symbols.",
              },
              limit: {
                type: "integer",
                description: "Maximum number of symbols to show (default 50).",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        async (input, ctx) => {
          const query = requireString(input, "query");
          const limit = Math.max(
            1,
            Math.floor(optionalNumber(input, "limit", 50)),
          );
          const sandbox = requireSandbox(ctx);
          const config = servers[0];
          if (!config) throw new Error("no language server is configured");
          const client = await clientForConfig(ctx, config);
          const symbols = await client.workspaceSymbols(query);
          return {
            ok: true,
            content: formatWorkspaceSymbols(sandbox, symbols, limit),
            meta: { query, count: symbols.length },
          };
        },
        { readOnly: true, verb: "Searching workspace symbols" },
      ),
    );
  }

  if (add("format")) {
    tools.push(
      defineTool(
        {
          name: "lsp_format",
          description:
            "Return formatting edits for a file or range. Does not write " +
            "files; apply the returned edits with edit_file or your formatter.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path." },
              tab_size: { type: "integer", description: "Tab size (default 2)." },
              insert_spaces: {
                type: "boolean",
                description: "Use spaces instead of tabs (default true).",
              },
              start_line: { type: "integer", description: "1-based start line." },
              start_column: {
                type: "integer",
                description: "1-based start column.",
              },
              end_line: { type: "integer", description: "1-based end line." },
              end_column: { type: "integer", description: "1-based end column." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
        async (input, ctx) => {
          const file = requireString(input, "path");
          const options = {
            tabSize: Math.max(
              1,
              Math.floor(optionalNumber(input, "tab_size", 2)),
            ),
            insertSpaces: optionalBoolean(input, "insert_spaces") ?? true,
          };
          const client = await clientFor(ctx, file, servers, repos);
          const hasRange =
            input.start_line !== undefined ||
            input.start_column !== undefined ||
            input.end_line !== undefined ||
            input.end_column !== undefined;
          const edits = hasRange
            ? await client.rangeFormatting(
                file,
                Math.max(1, Math.floor(optionalNumber(input, "start_line", 1))),
                Math.max(
                  1,
                  Math.floor(optionalNumber(input, "start_column", 1)),
                ),
                Math.max(
                  1,
                  Math.floor(optionalNumber(input, "end_line", 1)),
                ),
                Math.max(
                  1,
                  Math.floor(optionalNumber(input, "end_column", 1)),
                ),
                options,
              )
            : await client.formatting(file, options);
          const sandbox = requireSandbox(ctx);
          const uri = pathToFileURL(client.resolvePath(file)).href;
          return {
            ok: true,
            content: await spillOrTruncate(
              edits.length
                ? `${edits.length} formatting edit(s) for ${file} (not applied):\n${formatTextEdits(sandbox, uri, edits).join("\n")}`
                : `no formatting changes for ${file}`,
              { sandbox, label: "lsp_format" },
            ),
            meta: { path: file, count: edits.length, applied: false },
          };
        },
        { readOnly: true, verb: "Computing formatting edits" },
      ),
    );
  }

  if (add("rename")) {
    tools.push(
      defineTool(
        {
          name: "lsp_rename",
          description:
            "Return the workspace edit for renaming a symbol. Does not write " +
            "files; apply the returned edits with edit_file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path." },
              line: { type: "integer", description: "1-based line." },
              column: { type: "integer", description: "1-based column." },
              new_name: {
                type: "string",
                description: "Replacement symbol name.",
              },
            },
            required: ["path", "line", "column", "new_name"],
            additionalProperties: false,
          },
        },
        async (input, ctx) => {
          const file = requireString(input, "path");
          const line = Math.max(1, Math.floor(optionalNumber(input, "line", 1)));
          const column = Math.max(
            1,
            Math.floor(optionalNumber(input, "column", 1)),
          );
          const newName = requireString(input, "new_name");
          const client = await clientFor(ctx, file, servers, repos);
          const edit = await client.rename(file, line, column, newName);
          const sandbox = requireSandbox(ctx);
          return {
            ok: true,
            content: await spillOrTruncate(
              `rename to ${newName} (not applied):\n${formatWorkspaceEdit(sandbox, edit).join("\n")}`,
              { sandbox, label: "lsp_rename" },
            ),
            meta: {
              path: file,
              line,
              column,
              newName,
              files: Object.keys(edit.changes ?? {}).length,
              applied: false,
            },
          };
        },
        { readOnly: true, verb: "Computing rename edits" },
      ),
    );
  }

  if (add("folding_ranges")) {
    tools.push(
      defineTool(
        {
          name: "lsp_folding_ranges",
          description: "List foldable ranges for one file.",
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
          const client = await clientFor(ctx, file, servers, repos);
          const ranges = await client.foldingRanges(file);
          return {
            ok: true,
            content: formatFoldingRanges(ranges),
            meta: { path: file, count: ranges.length },
          };
        },
        { readOnly: true, verb: "Listing folding ranges" },
      ),
    );
  }

  if (add("inlay_hints")) {
    tools.push(
      defineTool(
        {
          name: "lsp_inlay_hints",
          description:
            "List inlay hints (inferred types, parameter names) for a file or range.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path." },
              start_line: { type: "integer", description: "1-based start line." },
              start_column: {
                type: "integer",
                description: "1-based start column.",
              },
              end_line: { type: "integer", description: "1-based end line." },
              end_column: { type: "integer", description: "1-based end column." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
        async (input, ctx) => {
          const file = requireString(input, "path");
          const client = await clientFor(ctx, file, servers, repos);
          const hints = await client.inlayHints(
            file,
            Math.max(1, Math.floor(optionalNumber(input, "start_line", 1))),
            Math.max(1, Math.floor(optionalNumber(input, "start_column", 1))),
            input.end_line === undefined
              ? undefined
              : Math.max(1, Math.floor(optionalNumber(input, "end_line", 1))),
            input.end_column === undefined
              ? undefined
              : Math.max(
                  1,
                  Math.floor(optionalNumber(input, "end_column", 1)),
                ),
          );
          return {
            ok: true,
            content: formatInlayHints(hints),
            meta: { path: file, count: hints.length },
          };
        },
        { readOnly: true, verb: "Listing inlay hints" },
      ),
    );
  }

  for (const [feature, method, label] of [
    ["type_definition", "typeDefinition", "type definitions"],
    ["implementation", "implementation", "implementations"],
    ["declaration", "declaration", "declarations"],
  ] as const) {
    if (!add(feature)) continue;
    tools.push(
      defineTool(
        {
          name: `lsp_${feature}`,
          description: `Find ${label} for the symbol at a 1-based line and column.`,
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
          const column = Math.max(
            1,
            Math.floor(optionalNumber(input, "column", 1)),
          );
          const client = await clientFor(ctx, file, servers, repos);
          const locations = await client[method](file, line, column);
          const sandbox = requireSandbox(ctx);
          return {
            ok: true,
            content: await spillOrTruncate(
              locations.length
                ? `${locations.length} ${label} for ${file}:${line}:${column}:\n${locations.map((item) => formatLocation(sandbox, item)).join("\n")}`
                : `no ${label} found at ${file}:${line}:${column}`,
              { sandbox, label: `lsp_${feature}` },
            ),
            meta: { path: file, line, column, count: locations.length },
          };
        },
        { readOnly: true, verb: `Finding ${label}` },
      ),
    );
  }

  return tools;
}

/** Default TypeScript/JavaScript LSP tools. */
export const lspTools: Tool[] = createLspTools();

/** All common LSP tools, including hover, completion, and edit previews. */
export const lspAllTools: Tool[] = createLspTools({ features: "all" });
