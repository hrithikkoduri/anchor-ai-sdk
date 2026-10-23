# Optional LSP tools

`anchor-ai-sdk/lsp` is an optional entry point built on the generic sandbox
process-stream primitive. Core stays free of LSP and JSON-RPC types; this
package owns the protocol, document lifecycle, and four read-only tools.

Status: v0.1.8. This page is source material for the documentation website.

## What it supports

TypeScript and JavaScript files:

| Tool | Purpose |
| --- | --- |
| `lsp_diagnostics` | Errors and warnings for one file |
| `lsp_definition` | Definition at a 1-based line/column |
| `lsp_references` | References at a 1-based line/column |
| `lsp_symbols` | Classes, functions, variables, and other document symbols |

`search` and `read_file` remain the fallback for other languages, missing
language servers, or when a quick text search is enough.

## Requirements

The sandbox image must contain:

- `typescript-language-server`
- `typescript`
- `node` (or a compatible runtime)

For example:

```dockerfile
RUN npm install -g typescript typescript-language-server
```

The sandbox must declare `capabilities.processStream: true` and implement
`openProcess`. Local, Docker, E2B, and Heyo do.

Heyo provides a PTY, not raw pipes. Its stderr is merged into stdout and
`endInput()` has Ctrl-D semantics. LSP framing is byte-sensitive regardless of
whether requests are read-only; operation over Heyo's PTY has not been
live-verified. Prefer Local/Docker/E2B pipe-backed transports for LSP.

## Tools

```ts
import { createCodingAgent, createCodingTools } from "anchor-ai-sdk";
import { createLspTools } from "anchor-ai-sdk/lsp";

const lspTools = createLspTools(); // default command: typescript-language-server
const agent = {
  ...createCodingAgent(),
  tools: [...createCodingTools(), ...lspTools],
};
```

Or use the default exported set:

```ts
import { lspTools } from "anchor-ai-sdk/lsp";
```

Configure a different language-server command:

```ts
const tools = createLspTools({
  command: "typescript-language-server",
  args: ["--stdio"],
});
```

If the server is missing, the tool returns an `ok: false` result explaining
what to install; it does not silently fall back to a different language.

## Direct client

Use `TypeScriptLsp` when you want LSP data without the agent tools:

```ts
import { TypeScriptLsp } from "anchor-ai-sdk/lsp";

const lsp = new TypeScriptLsp(sandbox);
try {
  await lsp.start();
  const diagnostics = await lsp.diagnostics("src/index.ts");
  const definition = await lsp.definition("src/index.ts", 10, 5);
  const references = await lsp.references("src/index.ts", 10, 5);
  const symbols = await lsp.symbols("src/index.ts");
} finally {
  await lsp.close();
}
```

Positions passed to the public client/tools are 1-based; the client converts
them to LSP's 0-based positions.

## Design boundary

- `Sandbox.openProcess()` is the only core primitive used.
- JSON-RPC framing, `initialize`/`shutdown`, diagnostics notifications,
  definition/reference normalization, and TypeScript language IDs live in
  `src/lsp/`.
- The LSP tools expose read-only language queries. They launch the configured
  server and use sandbox commands to probe its availability and read files;
  they do not offer file edits or arbitrary commands to the model.
- The client reads the current file through the sandbox before opening it, so
  the server sees the same checkout the agent sees.

## Verification

- `tests/unit/lsp.test.ts` covers split/concatenated Content-Length framing and
  runs the real `TypeScriptLsp` client against a stdio fixture server through
  `LocalSandbox.openProcess`.
- A real `typescript-language-server` needs a sandbox image that installs it;
  that is image configuration, not an Anchor dependency.
- Other languages are intentionally out of scope for this first entry point.
