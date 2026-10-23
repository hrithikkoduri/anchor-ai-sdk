/**
 * TypeScript/JavaScript language-server client over the generic
 * `Sandbox.openProcess` primitive. This is intentionally an optional entry
 * point: core never learns about LSP, JSON-RPC, or TypeScript.
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

export interface TypeScriptLspOptions {
  /** Default `typescript-language-server`; must exist inside the sandbox. */
  command?: string;
  args?: string[];
  /** Override the root URI; defaults to `sandbox.workspace`. */
  rootUri?: string;
  requestTimeoutMs?: number;
  diagnosticsTimeoutMs?: number;
}

interface WaitForDiagnostics {
  resolve: (diagnostics: LspDiagnostic[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The TypeScript/JavaScript LSP facade used by the optional tools. */
export class TypeScriptLsp {
  private readonly command: string;
  private readonly args: string[];
  private readonly workspace: string;
  private readonly rootUri: string;
  private readonly requestTimeoutMs: number;
  private readonly diagnosticsTimeoutMs: number;
  private readonly diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  private readonly diagnosticWaiters = new Map<string, WaitForDiagnostics[]>();
  private readonly versions = new Map<string, number>();
  private peer?: LspPeer;
  private starting?: Promise<void>;

  constructor(
    private readonly sandbox: Sandbox,
    opts: TypeScriptLspOptions = {},
  ) {
    this.workspace = sandbox.workspace;
    this.command = opts.command ?? "typescript-language-server";
    this.args = opts.args ?? ["--stdio"];
    this.rootUri = opts.rootUri ?? pathToFileURL(this.workspace).href;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.diagnosticsTimeoutMs = opts.diagnosticsTimeoutMs ?? 2_500;
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
      throw new Error(
        `${this.command} is not installed in the sandbox; add it to the image ` +
          "(for example: npm i -g typescript-language-server typescript)",
      );
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
      await peer.request(
        "initialize",
        {
          processId: null,
          clientInfo: { name: "anchor-ai-sdk-lsp", version: "0.1.8" },
          rootUri: this.rootUri,
          workspaceFolders: [
            { uri: this.rootUri, name: path.basename(this.workspace) },
          ],
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
      return (params?.items ?? []).map(() => null);
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
    const languageId = languageFor(abs);
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

  async diagnostics(
    file: string,
    timeoutMs = this.diagnosticsTimeoutMs,
  ): Promise<LspDiagnostic[]> {
    await this.start();
    const uri = pathToFileURL(this.resolvePath(file)).href;
    this.diagnosticsByUri.delete(uri);
    await this.openDocument(file);
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

function languageFor(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    default:
      throw new Error(
        `LSP tools currently support TypeScript/JavaScript files, not ${path.extname(file) || "this file"}`,
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRange(value: unknown): value is LspRange {
  return isRecord(value) && isRecord(value.start) && isRecord(value.end);
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
