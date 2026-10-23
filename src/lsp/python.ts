/** Python preset for the generic LSP client. */
import type { Sandbox } from "../sandbox/types.js";
import { LspServer, type LspServerConfig } from "./server.js";

export interface PythonLspOptions {
  /** Default `pyright-langserver`; use `pylsp` or another server if preferred. */
  command?: string;
  args?: string[];
  rootUri?: string;
  requestTimeoutMs?: number;
  diagnosticsTimeoutMs?: number;
  initializationOptions?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  formattingOptions?: { tabSize?: number; insertSpaces?: boolean };
}

export function pythonLanguageServer(
  opts: PythonLspOptions = {},
): LspServerConfig {
  return {
    id: "python",
    command: opts.command ?? "pyright-langserver",
    args: opts.args ?? ["--stdio"],
    languageIds: {
      ".py": "python",
      ".pyi": "python",
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
      "install pyright (npm i -g pyright) or a Python language server in the sandbox image, or pass command/args",
  };
}

export class PythonLsp extends LspServer {
  constructor(sandbox: Sandbox, opts: PythonLspOptions = {}) {
    super(sandbox, pythonLanguageServer(opts));
  }
}
