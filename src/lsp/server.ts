/**
 * Generic language-server client over the generic `Sandbox.openProcess`
 * primitive. Language-specific commands and extension mappings belong in
 * presets such as `typescriptLanguageServer` and `pythonLanguageServer`.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Sandbox } from "../sandbox/types.js";
import { shq } from "../sandbox/types.js";
import { LspPeer } from "./client.js";
import type { JsonRpcMessage } from "./protocol.js";

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspLocation {
  uri: string;
  range: LspRange;
}
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}
export interface LspSymbol {
  name: string;
  kind: number;
  detail?: string;
  range: LspRange;
  children?: LspSymbol[];
}
export interface LspHover {
  contents: string;
  range?: LspRange;
}
export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
  filterText?: string;
  deprecated?: boolean;
}
export interface LspSignatureParameter {
  label: string;
  documentation?: string;
}
export interface LspSignature {
  label: string;
  documentation?: string;
  parameters?: LspSignatureParameter[];
}
export interface LspSignatureHelp {
  signatures: LspSignature[];
  activeSignature?: number;
  activeParameter?: number;
}
export interface LspWorkspaceSymbol {
  name: string;
  kind: number;
  location?: LspLocation;
  containerName?: string;
}
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
export interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabled?: string;
  edit?: unknown;
  command?: unknown;
}
export interface LspDocumentHighlight {
  range: LspRange;
  kind?: number;
}
export interface LspFoldingRange {
  startLine: number;
  endLine: number;
  kind?: string;
  collapsedText?: string;
}
export interface LspInlayHint {
  position: LspPosition;
  label: string;
  kind?: number;
  tooltip?: string;
}
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: unknown[];
}

export interface LspServerConfig {
  /** Stable id used for client caching and diagnostics. */
  id: string;
  /** Command inside the sandbox, e.g. typescript-language-server or pyright-langserver. */
  command: string;
  args?: string[];
  /** File extension (including dot) to LSP languageId. */
  languageIds: Record<string, string>;
  /** Override the root URI; defaults to the sandbox workspace. */
  rootUri?: string;
  initializationOptions?: Record<string, unknown>;
  /** Answers for server `workspace/configuration` requests. */
  configuration?: Record<string, unknown>;
  formattingOptions?: { tabSize?: number; insertSpaces?: boolean };
  requestTimeoutMs?: number;
  diagnosticsTimeoutMs?: number;
  /** Shown when the command is missing from the image. */
  installHint?: string;
}

/** The generic language-server client used by every language preset. */

interface WaitForDiagnostics {
  resolve: (diagnostics: LspDiagnostic[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspServer {
  private readonly command: string;
  private readonly args: string[];
  private readonly workspace: string;
  private readonly rootUri: string;
  private readonly requestTimeoutMs: number;
  private readonly diagnosticsTimeoutMs: number;
  private readonly languageIds: Record<string, string>;
  private readonly initializationOptions?: Record<string, unknown>;
  private readonly configuration?: Record<string, unknown>;
  private readonly formattingOptions: { tabSize: number; insertSpaces: boolean };
  private readonly installHint: string;
  private readonly diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  private readonly diagnosticWaiters = new Map<string, WaitForDiagnostics[]>();
  private readonly versions = new Map<string, number>();
  private readonly texts = new Map<string, string>();
  private serverCapabilities: Record<string, unknown> = {};
  private peer?: LspPeer;
  private starting?: Promise<void>;

  constructor(
    private readonly sandbox: Sandbox,
    config: LspServerConfig,
  ) {
    this.workspace = sandbox.workspace;
    this.command = config.command;
    this.args = config.args ?? [];
    this.rootUri = config.rootUri ?? pathToFileURL(this.workspace).href;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.diagnosticsTimeoutMs = config.diagnosticsTimeoutMs ?? 2_500;
    this.languageIds = config.languageIds;
    this.initializationOptions = config.initializationOptions;
    this.configuration = config.configuration;
    this.formattingOptions = {
      tabSize: config.formattingOptions?.tabSize ?? 2,
      insertSpaces: config.formattingOptions?.insertSpaces ?? true,
    };
    this.installHint = config.installHint ?? `install ${config.command} in the sandbox image`;
  }

  async start(): Promise<void> {
    if (this.peer) return;
    this.starting ??= this.open().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private async open(): Promise<void> {
    if (!this.sandbox.openProcess) {
      throw new Error(
        "LSP needs a sandbox with processStream: true (openProcess is unavailable)",
      );
    }
    const probe = await this.sandbox.exec(`command -v ${shq(this.command)}`, {
      timeoutSecs: 30,
      concurrent: true,
    });
    if (probe.exitCode !== 0) {
      throw new Error(`${this.command} is not installed in the sandbox; ${this.installHint}`);
    }
    const process = await this.sandbox.openProcess(this.command, this.args, {
      cwd: this.workspace,
      timeoutSecs: 3600,
    });
    const peer = new LspPeer(process, {
      onNotification: (message) => this.notification(message),
      onRequest: (message) => this.serverRequest(message),
    });
    peer.start();
    this.peer = peer;
    try {
      const initialized = await peer.request(
        "initialize",
        {
          processId: null,
          clientInfo: { name: "anchor-ai-sdk-lsp" },
          rootUri: this.rootUri,
          workspaceFolders: [
            { uri: this.rootUri, name: path.basename(this.workspace) },
          ],
          ...(this.initializationOptions !== undefined
            ? { initializationOptions: this.initializationOptions }
            : {}),
          capabilities: {
            workspace: { workspaceFolders: true },
            textDocument: {
              synchronization: { dynamicRegistration: false },
              definition: { linkSupport: true },
              references: {},
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              publishDiagnostics: {},
            },
          },
        },
        this.requestTimeoutMs,
      );
      this.serverCapabilities =
        isRecord(initialized) && isRecord(initialized.capabilities)
          ? initialized.capabilities
          : {};
      await peer.notify("initialized", {});
    } catch (error) {
      await peer.close();
      this.peer = undefined;
      throw error;
    }
  }

  private notification(message: JsonRpcMessage): void {
    if (message.method !== "textDocument/publishDiagnostics") return;
    const params = message.params as {
      uri?: string;
      diagnostics?: LspDiagnostic[];
    } | null;
    if (!params?.uri) return;
    const diagnostics = params.diagnostics ?? [];
    this.diagnosticsByUri.set(params.uri, diagnostics);
    for (const waiter of this.diagnosticWaiters.get(params.uri) ?? []) {
      clearTimeout(waiter.timer);
      waiter.resolve(diagnostics);
    }
    this.diagnosticWaiters.delete(params.uri);
  }

  private async serverRequest(message: JsonRpcMessage): Promise<unknown> {
    if (message.method === "workspace/configuration") {
      const params = message.params as { items?: unknown[] } | null;
      return (params?.items ?? []).map((item) => {
        const section =
          isRecord(item) && typeof item.section === "string"
            ? item.section
            : undefined;
        if (section === "formattingOptions") return this.formattingOptions;
        if (section) return this.configuration?.[section] ?? null;
        return null;
      });
    }
    if (message.method === "workspace/workspaceFolders") {
      return [{ uri: this.rootUri, name: path.basename(this.workspace) }];
    }
    return null;
  }

  /** Absolute guest path for a tool argument. */
  resolvePath(file: string): string {
    return path.isAbsolute(file) ? file : path.resolve(this.workspace, file);
  }

  async openDocument(file: string): Promise<string> {
    await this.start();
    const abs = this.resolvePath(file);
    const uri = pathToFileURL(abs).href;
    const read = await this.sandbox.exec(`cat -- ${shq(abs)}`, {
      timeoutSecs: 30,
      concurrent: true,
    });
    if (read.exitCode !== 0) {
      throw new Error(`cannot read ${file}: ${(read.stderr || read.output).trim()}`);
    }
    const text = read.stdout;
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.texts.set(uri, text);
    const languageId = languageFor(abs, this.languageIds);
    if (version === 1) {
      await this.peer!.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text },
      });
    } else {
      await this.peer!.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  /** Server capabilities returned by `initialize`. */
  get capabilities(): Record<string, unknown> {
    return this.serverCapabilities;
  }

  /** Escape hatch for any standard or vendor-specific LSP request. */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    await this.start();
    return (await this.peer!.request(method, params, timeoutMs)) as T;
  }

  /** Escape hatch for notifications such as `workspace/didChangeConfiguration`. */
  async notify(method: string, params?: unknown): Promise<void> {
    await this.start();
    await this.peer!.notify(method, params);
  }

  async closeDocument(file: string): Promise<void> {
    const uri = pathToFileURL(this.resolvePath(file)).href;
    if (!this.versions.has(uri)) return;
    await this.notify("textDocument/didClose", { textDocument: { uri } });
    this.versions.delete(uri);
    this.texts.delete(uri);
    this.diagnosticsByUri.delete(uri);
  }

  async diagnostics(
    file: string,
    timeoutMs = this.diagnosticsTimeoutMs,
  ): Promise<LspDiagnostic[]> {
    await this.start();
    const uri = pathToFileURL(this.resolvePath(file)).href;
    this.diagnosticsByUri.delete(uri);
    await this.openDocument(file);
    if (this.serverCapabilities.diagnosticProvider) {
      const pulled = await this.pullDiagnosticsForUri(uri, timeoutMs).catch(
        () => undefined,
      );
      if (pulled) return pulled;
    }
    const cached = this.diagnosticsByUri.get(uri);
    if (cached) return cached;
    return new Promise((resolve) => {
      const waiter: WaitForDiagnostics = {
        resolve,
        timer: setTimeout(() => {
          const list = this.diagnosticWaiters.get(uri) ?? [];
          this.diagnosticWaiters.set(
            uri,
            list.filter((entry) => entry !== waiter),
          );
          resolve([]);
        }, timeoutMs),
      };
      const list = this.diagnosticWaiters.get(uri) ?? [];
      list.push(waiter);
      this.diagnosticWaiters.set(uri, list);
    });
  }

  async definition(
    file: string,
    line: number,
    column: number,
  ): Promise<LspLocation[]> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/definition",
      {
        textDocument: { uri },
        position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
      },
      this.requestTimeoutMs,
    );
    return normalizeLocations(result);
  }

  async references(
    file: string,
    line: number,
    column: number,
    includeDeclaration = true,
  ): Promise<LspLocation[]> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/references",
      {
        textDocument: { uri },
        position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
        context: { includeDeclaration },
      },
      this.requestTimeoutMs,
    );
    return normalizeLocations(result);
  }

  async symbols(file: string): Promise<LspSymbol[]> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
      this.requestTimeoutMs,
    );
    return normalizeSymbols(result);
  }

  /** Pull diagnostics for servers that use `textDocument/diagnostic`. */
  async pullDiagnostics(
    file: string,
    timeoutMs = this.diagnosticsTimeoutMs,
  ): Promise<LspDiagnostic[]> {
    const uri = await this.openDocument(file);
    return (await this.pullDiagnosticsForUri(uri, timeoutMs)) ?? [];
  }

  private async pullDiagnosticsForUri(
    uri: string,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | undefined> {
    const result = await this.peer!.request(
      "textDocument/diagnostic",
      { textDocument: { uri } },
      timeoutMs,
    );
    if (!isRecord(result)) return undefined;
    if (Array.isArray(result.items)) {
      return result.items as LspDiagnostic[];
    }
    if (result.kind === "unchanged") {
      return this.diagnosticsByUri.get(uri) ?? [];
    }
    return [];
  }

  async hover(
    file: string,
    line: number,
    column: number,
  ): Promise<LspHover | null> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/hover",
      { textDocument: { uri }, position: toPosition(line, column) },
      this.requestTimeoutMs,
    );
    return normalizeHover(result);
  }

  async completion(
    file: string,
    line: number,
    column: number,
    triggerCharacter?: string,
  ): Promise<LspCompletionItem[]> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: toPosition(line, column),
        ...(triggerCharacter
          ? { context: { triggerKind: 2, triggerCharacter } }
          : {}),
      },
      this.requestTimeoutMs,
    );
    return normalizeCompletions(result);
  }

  async signatureHelp(
    file: string,
    line: number,
    column: number,
  ): Promise<LspSignatureHelp | null> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/signatureHelp",
      { textDocument: { uri }, position: toPosition(line, column) },
      this.requestTimeoutMs,
    );
    return normalizeSignatureHelp(result);
  }

  async documentHighlights(
    file: string,
    line: number,
    column: number,
  ): Promise<LspDocumentHighlight[]> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/documentHighlight",
      { textDocument: { uri }, position: toPosition(line, column) },
      this.requestTimeoutMs,
    );
    return normalizeDocumentHighlights(result);
  }

  async codeActions(
    file: string,
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
    diagnostics: LspDiagnostic[] = [],
    only?: string[],
  ): Promise<LspCodeAction[]> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/codeAction",
      {
        textDocument: { uri },
        range: toRange(startLine, startColumn, endLine, endColumn),
        context: {
          diagnostics,
          ...(only ? { only } : {}),
        },
      },
      this.requestTimeoutMs,
    );
    return normalizeCodeActions(result);
  }

  async workspaceSymbols(query: string): Promise<LspWorkspaceSymbol[]> {
    await this.start();
    const result = await this.peer!.request(
      "workspace/symbol",
      { query },
      this.requestTimeoutMs,
    );
    return normalizeWorkspaceSymbols(result);
  }

  async formatting(
    file: string,
    options = this.formattingOptions,
  ): Promise<LspTextEdit[]> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/formatting",
      { textDocument: { uri }, options },
      this.requestTimeoutMs,
    );
    return normalizeTextEdits(result);
  }

  async rangeFormatting(
    file: string,
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
    options = this.formattingOptions,
  ): Promise<LspTextEdit[]> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/rangeFormatting",
      {
        textDocument: { uri },
        range: toRange(startLine, startColumn, endLine, endColumn),
        options,
      },
      this.requestTimeoutMs,
    );
    return normalizeTextEdits(result);
  }

  async rename(
    file: string,
    line: number,
    column: number,
    newName: string,
  ): Promise<LspWorkspaceEdit> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/rename",
      {
        textDocument: { uri },
        position: toPosition(line, column),
        newName,
      },
      this.requestTimeoutMs,
    );
    return normalizeWorkspaceEdit(result);
  }

  async foldingRanges(file: string): Promise<LspFoldingRange[]> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      "textDocument/foldingRange",
      { textDocument: { uri } },
      this.requestTimeoutMs,
    );
    return normalizeFoldingRanges(result);
  }

  async inlayHints(
    file: string,
    startLine = 1,
    startColumn = 1,
    endLine?: number,
    endColumn?: number,
  ): Promise<LspInlayHint[]> {
    const uri = await this.openDocument(file);
    const text = this.texts.get(uri) ?? "";
    const lastLine = Math.max(1, text.split("\n").length);
    const result = await this.peer!.request(
      "textDocument/inlayHint",
      {
        textDocument: { uri },
        range: toRange(
          startLine,
          startColumn,
          endLine ?? lastLine,
          endColumn ?? 1,
        ),
      },
      this.requestTimeoutMs,
    );
    return normalizeInlayHints(result);
  }

  async typeDefinition(
    file: string,
    line: number,
    column: number,
  ): Promise<LspLocation[]> {
    return this.locations("textDocument/typeDefinition", file, line, column);
  }

  async implementation(
    file: string,
    line: number,
    column: number,
  ): Promise<LspLocation[]> {
    return this.locations("textDocument/implementation", file, line, column);
  }

  async declaration(
    file: string,
    line: number,
    column: number,
  ): Promise<LspLocation[]> {
    return this.locations("textDocument/declaration", file, line, column);
  }

  async executeCommand(
    command: string,
    args: unknown[] = [],
  ): Promise<unknown> {
    await this.start();
    return this.peer!.request(
      "workspace/executeCommand",
      { command, arguments: args },
      this.requestTimeoutMs,
    );
  }

  private async locations(
    method: string,
    file: string,
    line: number,
    column: number,
  ): Promise<LspLocation[]> {
    const uri = await this.openDocument(file);
    const result = await this.peer!.request(
      method,
      { textDocument: { uri }, position: toPosition(line, column) },
      this.requestTimeoutMs,
    );
    return normalizeLocations(result);
  }

  async close(): Promise<void> {
    const peer = this.peer;
    this.peer = undefined;
    this.starting = undefined;
    if (!peer) return;
    await peer.request("shutdown", undefined, 5_000).catch(() => undefined);
    await peer.notify("exit").catch(() => undefined);
    await peer.close();
  }
}

function languageFor(
  file: string,
  languageIds: Record<string, string>,
): string {
  const extension = path.extname(file).toLowerCase();
  const languageId = languageIds[extension];
  if (!languageId) {
    const supported = Object.keys(languageIds).join(", ");
    throw new Error(
      `no language server is configured for ${extension || "this file"}; supported extensions: ${supported}`,
    );
  }
  return languageId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRange(value: unknown): value is LspRange {
  return isRecord(value) && isRecord(value.start) && isRecord(value.end);
}

function toPosition(line: number, column: number): LspPosition {
  return {
    line: Math.max(0, Math.floor(line) - 1),
    character: Math.max(0, Math.floor(column) - 1),
  };
}

function toRange(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): LspRange {
  return {
    start: toPosition(startLine, startColumn),
    end: toPosition(endLine, endColumn),
  };
}

function markupText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(markupText).filter(Boolean).join("\n\n");
  }
  if (isRecord(value) && typeof value.value === "string") {
    return value.value;
  }
  return "";
}

function normalizeHover(value: unknown): LspHover | null {
  if (!isRecord(value)) return null;
  const contents = markupText(value.contents).trim();
  if (!contents) return null;
  return {
    contents,
    ...(isRange(value.range) ? { range: value.range } : {}),
  };
}

function normalizeCompletions(value: unknown): LspCompletionItem[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : [];
  return items.flatMap((entry): LspCompletionItem[] => {
    if (!isRecord(entry) || typeof entry.label !== "string") return [];
    const documentation = markupText(entry.documentation);
    return [
      {
        label: entry.label,
        ...(typeof entry.kind === "number" ? { kind: entry.kind } : {}),
        ...(typeof entry.detail === "string" ? { detail: entry.detail } : {}),
        ...(documentation ? { documentation } : {}),
        ...(typeof entry.insertText === "string"
          ? { insertText: entry.insertText }
          : {}),
        ...(typeof entry.sortText === "string"
          ? { sortText: entry.sortText }
          : {}),
        ...(typeof entry.filterText === "string"
          ? { filterText: entry.filterText }
          : {}),
        ...(entry.deprecated === true ? { deprecated: true } : {}),
      },
    ];
  });
}

function normalizeSignatureHelp(value: unknown): LspSignatureHelp | null {
  if (!isRecord(value) || !Array.isArray(value.signatures)) return null;
  const signatures = value.signatures.flatMap((entry): LspSignature[] => {
    if (!isRecord(entry) || typeof entry.label !== "string") return [];
    const documentation = markupText(entry.documentation);
    const parameters = Array.isArray(entry.parameters)
      ? entry.parameters.flatMap((parameter): LspSignatureParameter[] => {
          if (!isRecord(parameter)) return [];
          const label =
            typeof parameter.label === "string"
              ? parameter.label
              : Array.isArray(parameter.label)
                ? parameter.label.join("-")
                : "";
          if (!label) return [];
          const parameterDocumentation = markupText(parameter.documentation);
          return [
            {
              label,
              ...(parameterDocumentation
                ? { documentation: parameterDocumentation }
                : {}),
            },
          ];
        })
      : undefined;
    return [
      {
        label: entry.label,
        ...(documentation ? { documentation } : {}),
        ...(parameters ? { parameters } : {}),
      },
    ];
  });
  if (!signatures.length) return null;
  return {
    signatures,
    ...(typeof value.activeSignature === "number"
      ? { activeSignature: value.activeSignature }
      : {}),
    ...(typeof value.activeParameter === "number"
      ? { activeParameter: value.activeParameter }
      : {}),
  };
}

function normalizeDocumentHighlights(value: unknown): LspDocumentHighlight[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LspDocumentHighlight[] => {
    if (!isRecord(entry) || !isRange(entry.range)) return [];
    return [
      {
        range: entry.range,
        ...(typeof entry.kind === "number" ? { kind: entry.kind } : {}),
      },
    ];
  });
}

function normalizeCodeActions(value: unknown): LspCodeAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LspCodeAction[] => {
    if (!isRecord(entry) || typeof entry.title !== "string") return [];
    const disabled =
      isRecord(entry.disabled) && typeof entry.disabled.reason === "string"
        ? entry.disabled.reason
        : undefined;
    return [
      {
        title: entry.title,
        ...(typeof entry.kind === "string" ? { kind: entry.kind } : {}),
        ...(entry.isPreferred === true ? { isPreferred: true } : {}),
        ...(disabled ? { disabled } : {}),
        ...(entry.edit !== undefined ? { edit: entry.edit } : {}),
        ...(entry.command !== undefined ? { command: entry.command } : {}),
      },
    ];
  });
}

function normalizeWorkspaceSymbols(value: unknown): LspWorkspaceSymbol[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LspWorkspaceSymbol[] => {
    if (!isRecord(entry) || typeof entry.name !== "string") return [];
    const location = isRecord(entry.location)
      ? normalizeLocations(entry.location)[0]
      : undefined;
    return [
      {
        name: entry.name,
        kind: typeof entry.kind === "number" ? entry.kind : 0,
        ...(location ? { location } : {}),
        ...(typeof entry.containerName === "string"
          ? { containerName: entry.containerName }
          : {}),
      },
    ];
  });
}

function normalizeTextEdits(value: unknown): LspTextEdit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LspTextEdit[] => {
    if (
      !isRecord(entry) ||
      !isRange(entry.range) ||
      typeof entry.newText !== "string"
    ) {
      return [];
    }
    return [{ range: entry.range, newText: entry.newText }];
  });
}

function normalizeWorkspaceEdit(value: unknown): LspWorkspaceEdit {
  if (!isRecord(value)) return {};
  const changes = isRecord(value.changes)
    ? Object.fromEntries(
        Object.entries(value.changes).flatMap(([uri, edits]) => {
          const normalized = normalizeTextEdits(edits);
          return normalized.length ? [[uri, normalized]] : [];
        }),
      )
    : undefined;
  return {
    ...(changes ? { changes } : {}),
    ...(Array.isArray(value.documentChanges)
      ? { documentChanges: value.documentChanges }
      : {}),
  };
}

function normalizeFoldingRanges(value: unknown): LspFoldingRange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LspFoldingRange[] => {
    if (
      !isRecord(entry) ||
      typeof entry.startLine !== "number" ||
      typeof entry.endLine !== "number"
    ) {
      return [];
    }
    return [
      {
        startLine: entry.startLine,
        endLine: entry.endLine,
        ...(typeof entry.kind === "string" ? { kind: entry.kind } : {}),
        ...(typeof entry.collapsedText === "string"
          ? { collapsedText: entry.collapsedText }
          : {}),
      },
    ];
  });
}

function normalizeInlayHints(value: unknown): LspInlayHint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LspInlayHint[] => {
    if (
      !isRecord(entry) ||
      !isRecord(entry.position) ||
      typeof entry.position.line !== "number" ||
      typeof entry.position.character !== "number"
    ) {
      return [];
    }
    const label = Array.isArray(entry.label)
      ? entry.label
          .map((part) =>
            isRecord(part) && typeof part.value === "string" ? part.value : "",
          )
          .join("")
      : typeof entry.label === "string"
        ? entry.label
        : "";
    if (!label) return [];
    const tooltip = markupText(entry.tooltip);
    return [
      {
        position: {
          line: entry.position.line,
          character: entry.position.character,
        },
        label,
        ...(typeof entry.kind === "number" ? { kind: entry.kind } : {}),
        ...(tooltip ? { tooltip } : {}),
      },
    ];
  });
}

function normalizeLocations(value: unknown): LspLocation[] {
  const values: unknown[] = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((entry: unknown): LspLocation[] => {
    if (!isRecord(entry)) return [];
    if (typeof entry.uri === "string" && isRange(entry.range)) {
      return [{ uri: entry.uri, range: entry.range }];
    }
    if (typeof entry.targetUri === "string" && isRange(entry.targetRange)) {
      return [{ uri: entry.targetUri, range: entry.targetRange }];
    }
    return [];
  });
}

function normalizeSymbols(value: unknown): LspSymbol[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LspSymbol[] => {
    if (!isRecord(entry) || typeof entry.name !== "string") return [];
    const range =
      isRange(entry.range)
        ? entry.range
        : isRecord(entry.location) && isRange(entry.location.range)
          ? entry.location.range
          : undefined;
    if (!range) return [];
    const children = normalizeSymbols(entry.children);
    return [
      {
        name: entry.name,
        kind: typeof entry.kind === "number" ? entry.kind : 0,
        ...(typeof entry.detail === "string" ? { detail: entry.detail } : {}),
        range,
        ...(children.length ? { children } : {}),
      },
    ];
  });
}

/** Convert an LSP file URI to a guest path for display. */
export function lspUriToPath(uri: string): string {
  if (uri.startsWith("file://")) return fileURLToPath(uri);
  return uri;
}
