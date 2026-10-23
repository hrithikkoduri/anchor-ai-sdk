/**
 * Optional `anchor-ai-sdk/lsp` entry point.
 *
 * Core knows only `Sandbox.openProcess`; JSON-RPC framing, LSP lifecycle, and
 * TypeScript/JavaScript tools live here. Consumers opt in by adding
 * `createLspTools()` to their agent's toolbox, or by using `TypeScriptLsp`
 * directly. Grep/search remains the fallback.
 */
export { TypeScriptLsp, lspUriToPath } from "./typescript.js";
export type {
  LspDiagnostic,
  LspLocation,
  LspPosition,
  LspRange,
  LspSymbol,
  TypeScriptLspOptions,
} from "./typescript.js";
export { createLspTools, lspTools } from "./tools.js";
export { LspPeer } from "./client.js";
export { encodeLspMessage, LspFramer } from "./protocol.js";
export type { JsonRpcId, JsonRpcMessage } from "./protocol.js";
