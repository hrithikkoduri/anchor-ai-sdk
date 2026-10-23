# Optional LSP tools

`anchor-ai-sdk/lsp` is an optional entry point built on the generic sandbox
process-stream primitive. Core stays free of LSP and JSON-RPC types; the
package owns the protocol, document lifecycle, language-server presets, and
four read-only tools.

Status: on `main` after v0.1.9. TypeScript/JavaScript is the default preset;
Python is available as a second preset.

## What it supports

The client is language-agnostic. A server definition maps file extensions to
LSP language IDs, so the same tools work with any stdio language server the
sandbox image provides.

| Tool | Purpose |
| --- | --- |
| `lsp_diagnostics` | Errors and warnings for one file |
| `lsp_definition` | Definition at a 1-based line/column |
| `lsp_references` | References at a 1-based line/column |
| `lsp_symbols` | Classes, functions, variables, and other document symbols |

Built-in presets:

| Preset | Default command | File extensions |
| --- | --- | --- |
| TypeScript/JavaScript | `typescript-language-server --stdio` | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `pyright-langserver --stdio` | `.py`, `.pyi` |

`search` and `read_file` remain the fallback for unsupported files, missing
language servers, or when a quick text search is enough.

## Requirements

The sandbox image must contain the language server you configure.

For TypeScript/JavaScript:

```dockerfile
RUN npm install -g typescript typescript-language-server
```

For Python with the default preset:

```dockerfile
RUN npm install -g pyright
```

`pyright-langserver` ships with the `pyright` npm package. If you prefer
`pylsp`, install it and pass `command: "pylsp", args: []` to
`pythonLanguageServer()`.

For another language, install its server and define a matching
`LspServerConfig`. Anchor does not install language servers automatically.

The sandbox must declare `capabilities.processStream: true` and implement
`openProcess`. Local, Docker, E2B, and Heyo do.

Heyo provides a PTY, not raw pipes. Its stderr is merged into stdout and
`endInput()` has Ctrl-D semantics. LSP framing is byte-sensitive regardless of
whether requests are read-only; operation over Heyo's PTY has not been
live-verified. Prefer Local/Docker/E2B pipe-backed transports for LSP.

## Tools

The default tools use the TypeScript/JavaScript preset:

```ts
import { createCodingAgent, createCodingTools } from "anchor-ai-sdk";
import { createLspTools } from "anchor-ai-sdk/lsp";

const lspTools = createLspTools(); // typescript-language-server --stdio
const agent = {
  ...createCodingAgent(),
  tools: [...createCodingTools(), ...lspTools],
};
```

Or use the default exported set:

```ts
import { lspTools } from "anchor-ai-sdk/lsp";
```

Use Python only:

```ts
import { createLspTools, pythonLanguageServer } from "anchor-ai-sdk/lsp";

const tools = createLspTools({
  servers: [pythonLanguageServer()],
});
```

Use TypeScript and Python together:

```ts
import {
  createLspTools,
  pythonLanguageServer,
  typescriptLanguageServer,
} from "anchor-ai-sdk/lsp";

const tools = createLspTools({
  servers: [typescriptLanguageServer(), pythonLanguageServer()],
});
```

The tools select the first configured server whose `languageIds` contains the
file extension. Clients are cached per sandbox and server `id`. An unsupported
extension fails with the list of configured extensions; it does not silently
switch languages.

Configure a different command through the preset:

```ts
const tools = createLspTools({
  servers: [
    pythonLanguageServer({
      command: "pylsp",
      args: [],
      initializationOptions: { pylsp: { plugins: { pycodestyle: { enabled: false } } } },
    }),
  ],
});
```

If the server is missing, the tool returns an `ok: false` result explaining
what to install; it does not silently fall back to a different language.

## Other languages

Any Language Server Protocol server that speaks stdio can be used through
`LspServerConfig`:

```ts
import { createLspTools, type LspServerConfig } from "anchor-ai-sdk/lsp";

const go: LspServerConfig = {
  id: "go",
  command: "gopls",
  args: ["serve"],
  languageIds: { ".go": "go" },
  installHint: "install gopls in the sandbox image, or pass a different command",
};

const tools = createLspTools({ servers: [go] });
```

The same shape covers `rust-analyzer`, `clangd`, `jdtls`, `ruby-lsp`, and other
servers. Per-language setup such as Python virtualenvs, C/C++
`compile_commands.json`, Java project imports, and Ruby Bundler environments is
the consumer image's responsibility. Heavy servers also need enough image memory
and startup time.

## Direct client

Use `TypeScriptLsp`, `PythonLsp`, or the generic `LspServer` when you want LSP
data without the agent tools:

```ts
import { PythonLsp, LspServer, pythonLanguageServer } from "anchor-ai-sdk/lsp";

const lsp = new PythonLsp(sandbox);
try {
  await lsp.start();
  const diagnostics = await lsp.diagnostics("src/app.py");
  const definition = await lsp.definition("src/app.py", 10, 5);
  const references = await lsp.references("src/app.py", 10, 5);
  const symbols = await lsp.symbols("src/app.py");
} finally {
  await lsp.close();
}

// Or construct the generic client from any config.
const generic = new LspServer(sandbox, pythonLanguageServer({ command: "pylsp", args: [] }));
```

Positions passed to the public client/tools are 1-based; the client converts
them to LSP's 0-based positions.

## Design boundary

- `Sandbox.openProcess()` is the only core primitive used.
- `src/lsp/server.ts` owns JSON-RPC framing, `initialize`/`shutdown`,
  diagnostics notifications, definition/reference normalization, and document
  synchronization.
- `src/lsp/typescript.ts` and `src/lsp/python.ts` are thin presets: command,
  arguments, extension-to-language-ID mapping, and install hints.
- `src/lsp/tools.ts` selects a preset by extension and caches one client per
  sandbox/server.
- The LSP tools expose read-only language queries. They launch the configured
  server and use sandbox commands to probe its availability and read files;
  they do not offer file edits or arbitrary commands to the model.
- The client reads the current file through the sandbox before opening it, so
  the server sees the same checkout the agent sees.

## Verification

- `tests/unit/lsp.test.ts` covers split/concatenated Content-Length framing,
  the real `TypeScriptLsp` client against a stdio fixture server through
  `LocalSandbox.openProcess`, and the Python preset plus extension-based tool
  selection.
- Real TypeScript, Python, and other language servers need sandbox images that
  install them; that is image configuration, not an Anchor dependency.
- The fixture test does not prove a live `pyright-langserver` or `pylsp` session
  on every provider. Validate the chosen server and image before relying on it
  in production.
