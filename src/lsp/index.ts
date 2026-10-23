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
  LspDiagnostic,
  LspLocation,
  LspPosition,
  LspRange,
  LspServerConfig,
  LspSymbol,
} from "./server.js";
export {
  TypeScriptLsp,
  typescriptLanguageServer,
} from "./typescript.js";
export type { TypeScriptLspOptions } from "./typescript.js";
export { PythonLsp, pythonLanguageServer } from "./python.js";
export type { PythonLspOptions } from "./python.js";
export { createLspTools, lspTools } from "./tools.js";
export type { LspToolsOptions } from "./tools.js";
export { LspPeer } from "./client.js";
export { encodeLspMessage, LspFramer } from "./protocol.js";
export type { JsonRpcId, JsonRpcMessage } from "./protocol.js";
