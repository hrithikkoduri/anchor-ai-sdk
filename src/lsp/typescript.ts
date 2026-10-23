/** TypeScript/JavaScript preset for the generic LSP client. */
import type { Sandbox } from "../sandbox/types.js";
import { LspServer, type LspServerConfig } from "./server.js";

export interface TypeScriptLspOptions {
  /** Default `typescript-language-server`; must exist inside the sandbox. */
  command?: string;
  args?: string[];
  /** Override the root URI; defaults to `sandbox.workspace`. */
  rootUri?: string;
  requestTimeoutMs?: number;
  diagnosticsTimeoutMs?: number;
  initializationOptions?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  formattingOptions?: { tabSize?: number; insertSpaces?: boolean };
}

export function typescriptLanguageServer(
  opts: TypeScriptLspOptions = {},
): LspServerConfig {
  return {
    id: "typescript",
    command: opts.command ?? "typescript-language-server",
    args: opts.args ?? ["--stdio"],
    languageIds: {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".mts": "typescript",
      ".cts": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    ...(opts.rootUri ? { rootUri: opts.rootUri } : {}),
    ...(opts.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: opts.requestTimeoutMs }
      : {}),
    ...(opts.diagnosticsTimeoutMs !== undefined
      ? { diagnosticsTimeoutMs: opts.diagnosticsTimeoutMs }
      : {}),
    ...(opts.initializationOptions
      ? { initializationOptions: opts.initializationOptions }
      : {}),
    ...(opts.configuration ? { configuration: opts.configuration } : {}),
    ...(opts.formattingOptions
      ? { formattingOptions: opts.formattingOptions }
      : {}),
    installHint:
      "install typescript-language-server and typescript in the sandbox image, or pass command/args",
  };
}

/** Backward-compatible TypeScript/JavaScript facade. */
export class TypeScriptLsp extends LspServer {
  constructor(sandbox: Sandbox, opts: TypeScriptLspOptions = {}) {
    super(sandbox, typescriptLanguageServer(opts));
  }
}

export { lspUriToPath } from "./server.js";
export type {
  LspDiagnostic,
  LspLocation,
  LspPosition,
  LspRange,
  LspSymbol,
} from "./server.js";
