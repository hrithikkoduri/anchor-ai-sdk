# Optional LSP tools

`anchor-ai-sdk/lsp` is an optional entry point built on the generic sandbox
process-stream primitive. Core stays free of LSP and JSON-RPC types; the
package owns the protocol, document lifecycle, language-server presets, and
four read-only tools.

Status: on `main` after v0.1.9. TypeScript/JavaScript is the default preset;
Python is available as a second preset. The client covers the common editor
surface and exposes a generic request escape hatch for anything else.

## What it supports

The client is language-agnostic. A server definition maps file extensions to
LSP language IDs, so the same tools work with any stdio language server the
sandbox image provides.

Core tools (always included):

| Tool | Purpose |
| --- | --- |
| `lsp_diagnostics` | Errors and warnings for one file |
| `lsp_definition` | Definition at a 1-based line/column |
| `lsp_references` | References at a 1-based line/column |
| `lsp_symbols` | Classes, functions, variables, and other document symbols |

Additional read-only tools (`features: "all"` or an explicit list):

| Tool | Purpose |
| --- | --- |
| `lsp_hover` | Type information and documentation |
| `lsp_completion` | Completion candidates at a position |
| `lsp_signature_help` | Call signature and active parameter |
| `lsp_document_highlights` | Occurrences of a symbol in one file |
| `lsp_code_actions` | Quick fixes and refactors (metadata plus edits) |
| `lsp_workspace_symbols` | Search symbols across the workspace |
| `lsp_format` | Formatting edits for a file or range |
| `lsp_rename` | Workspace edit for a symbol rename |
| `lsp_folding_ranges` | Foldable ranges |
| `lsp_inlay_hints` | Inferred types and parameter-name hints |
| `lsp_type_definition` | Type definition locations |
| `lsp_implementation` | Implementation locations |
| `lsp_declaration` | Declaration locations |

`lsp_format` and `lsp_rename` return edits but do not write files. Apply them
with `edit_file` or the consumer's formatter. The direct client exposes the
same methods plus `request(method, params)` for standard or vendor-specific LSP
requests outside this list.

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

Include the full common editor surface:

```ts
import { createLspTools, lspAllTools } from "anchor-ai-sdk/lsp";

const all = createLspTools({ features: "all" });
const exported = lspAllTools; // same 17 tools
```

Pick individual extras to control prompt/tool-schema size:

```ts
const tools = createLspTools({
  features: ["hover", "completion", "signature_help", "code_actions"],
});
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
  const hover = await lsp.hover("src/app.py", 10, 5);
  const completions = await lsp.completion("src/app.py", 10, 5);
  const signature = await lsp.signatureHelp("src/app.py", 10, 5);
  const actions = await lsp.codeActions("src/app.py", 10, 5, 10, 9);
  const edits = await lsp.formatting("src/app.py");
  const rename = await lsp.rename("src/app.py", 10, 5, "new_name");
} finally {
  await lsp.close();
}

// Or construct the generic client from any config.
const generic = new LspServer(sandbox, pythonLanguageServer({ command: "pylsp", args: [] }));

// Escape hatch: any LSP request, including vendor extensions.
const ranges = await generic.request("textDocument/selectionRange", {
  textDocument: { uri: "file:///workspace/src/app.py" },
  positions: [{ line: 9, character: 4 }],
});
```

Positions passed to the public client/tools are 1-based; the client converts
them to LSP's 0-based positions. `request()` takes raw LSP positions (0-based).

## Design boundary

- `Sandbox.openProcess()` is the only core primitive used.
- `src/lsp/server.ts` owns JSON-RPC framing, `initialize`/`shutdown`,
  diagnostics notifications, definition/reference normalization, and document
  synchronization.
- `src/lsp/typescript.ts` and `src/lsp/python.ts` are thin presets: command,
  arguments, extension-to-language-ID mapping, and install hints.
- `src/lsp/tools.ts` selects a preset by extension and caches one client per
  sandbox/server.
- The LSP tools expose read-only language queries. `format` and `rename`
  return edits but never write files; the agent applies them through the normal
  edit tool or the consumer applies them in its own formatter.
- The tools launch the configured server and use sandbox commands to probe its
  availability and read files; they do not offer arbitrary commands to the
  model. `LspServer.request()` is a host-side escape hatch, not a model tool.
- The client reads the current file through the sandbox before opening it, so
  the server sees the same checkout the agent sees.

## Verification

- `tests/unit/lsp.test.ts` covers split/concatenated Content-Length framing,
  the real client against a stdio fixture server through
  `LocalSandbox.openProcess`, Python/TypeScript preset selection, the four core
  tools, the advanced methods, and the opt-in full tool set.
- Live smoke validation was run against real `pyright-langserver` and
  `typescript-language-server` binaries. Both returned diagnostics, symbols,
  hover, completion, signature help, workspace symbols, rename edits, and
  supported navigation results. Some methods are server-specific: pyright does
  not implement formatting/folding/inlay hints, and TypeScript does not
  implement `textDocument/declaration`; those return an LSP method error.
- Reproduce it with `npm run build` followed by
  `PYRIGHT_LANGSERVER=... TYPESCRIPT_LANGUAGE_SERVER=... TSSERVER_PATH=... node scripts/lsp-live-smoke.mjs`.
- Servers and images remain consumer configuration. Validate the chosen server,
  workspace root, and language runtime before relying on it in production.
- Real sessions require an image that installs the server; Anchor does not
  install server binaries.
