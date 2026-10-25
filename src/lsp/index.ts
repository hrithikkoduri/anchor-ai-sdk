/**
 * Optional `anchor-ai-sdk/lsp` entry point.
 *
 * Core knows only `Sandbox.openProcess`; JSON-RPC framing, LSP lifecycle, and
 * language-server presets live here. Consumers opt in by adding
 * `createLspTools()` to their agent's toolbox, or by using a preset client
 * directly. Grep/search remains the fallback.
 */
export { LspServer, lspUriToPath } from "./server.js";
export type {
  LspCodeAction,
  LspCompletionItem,
  LspDiagnostic,
  LspDocumentHighlight,
  LspFoldingRange,
  LspHover,
  LspInlayHint,
  LspLocation,
  LspPosition,
  LspRange,
  LspServerConfig,
  LspSignature,
  LspSignatureHelp,
  LspSignatureParameter,
  LspSymbol,
  LspTextEdit,
  LspWorkspaceEdit,
  LspWorkspaceSymbol,
} from "./server.js";
export {
  TypeScriptLsp,
  typescriptLanguageServer,
} from "./typescript.js";
export type { TypeScriptLspOptions } from "./typescript.js";
export { PythonLsp, pythonLanguageServer } from "./python.js";
export type { PythonLspOptions } from "./python.js";
export { closeLspSessions, createLspTools, lspAllTools, lspTools } from "./tools.js";
export type { LspToolFeature, LspToolsOptions } from "./tools.js";
export { LspPeer } from "./client.js";
export { encodeLspMessage, LspFramer } from "./protocol.js";
export type { JsonRpcId, JsonRpcMessage } from "./protocol.js";
