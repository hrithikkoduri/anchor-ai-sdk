/* Minimal stdio LSP fixture for the lsp client test. */
let buffer = Buffer.alloc(0);
/** The root the client initialized this server with; hover reports it. */
let rootUri = null;

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(message) {
  if (message.id !== undefined && message.method) {
    if (message.method === "initialize") {
      rootUri = message.params?.rootUri ?? null;
      send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
      return;
    }
    if (message.method === "shutdown") {
      send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
    const uri = message.params.textDocument.uri;
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 1,
            source: "fake",
            message: "fixture diagnostic",
          },
        ],
      },
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    try {
      const message = JSON.parse(body);
      if (message.method === "exit") process.exit(0);
      if (message.id !== undefined && message.method === "textDocument/definition") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{
            uri: message.params.textDocument.uri,
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
          }],
        });
      } else if (message.id !== undefined && message.method === "textDocument/references") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{
            uri: message.params.textDocument.uri,
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
          }],
        });
      } else if (message.id !== undefined && message.method === "textDocument/documentSymbol") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{
            name: "fixtureSymbol",
            kind: 12,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          }],
        });
      } else if (message.id !== undefined && message.method === "textDocument/hover") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            contents: { kind: "markdown", value: `**fixture hover** root=${rootUri}` },
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        });
      } else if (message.id !== undefined && message.method === "textDocument/completion") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            isIncomplete: false,
            items: [{
              label: "fixtureCompletion",
              kind: 3,
              detail: "fixture detail",
              documentation: { kind: "markdown", value: "fixture docs" },
            }],
          },
        });
      } else if (message.id !== undefined && message.method === "textDocument/signatureHelp") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            signatures: [{
              label: "fixture(value: string)",
              documentation: "fixture signature",
              parameters: [{ label: "value", documentation: "fixture parameter" }],
            }],
            activeSignature: 0,
            activeParameter: 0,
          },
        });
      } else if (message.id !== undefined && message.method === "textDocument/documentHighlight") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            kind: 1,
          }],
        });
      } else if (message.id !== undefined && message.method === "textDocument/codeAction") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{
            title: "fixture action",
            kind: "quickfix",
            isPreferred: true,
            edit: { changes: {} },
          }],
        });
      } else if (message.id !== undefined && message.method === "workspace/symbol") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{
            name: "fixtureWorkspaceSymbol",
            kind: 12,
            containerName: "fixture",
            location: {
              uri: message.params?.query === "missing"
                ? "file:///fixture.ts"
                : "file:///fixture.ts",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            },
          }],
        });
      } else if (message.id !== undefined && message.method === "textDocument/formatting") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            newText: "formatted",
          }],
        });
      } else if (message.id !== undefined && message.method === "textDocument/rangeFormatting") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            newText: "range-formatted",
          }],
        });
      } else if (message.id !== undefined && message.method === "textDocument/rename") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            changes: {
              [message.params.textDocument.uri]: [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                newText: message.params.newName,
              }],
            },
          },
        });
      } else if (message.id !== undefined && message.method === "textDocument/foldingRange") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{ startLine: 0, endLine: 2, kind: "region" }],
        });
      } else if (message.id !== undefined && message.method === "textDocument/inlayHint") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{
            position: { line: 0, character: 1 },
            label: [{ value: ": " }, { value: "number" }],
            kind: 1,
          }],
        });
      } else if (
        message.id !== undefined &&
        ["textDocument/typeDefinition", "textDocument/implementation", "textDocument/declaration"].includes(message.method)
      ) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{
            uri: message.params.textDocument.uri,
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
          }],
        });
      } else if (message.id !== undefined && message.method === "workspace/executeCommand") {
        send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
      } else {
        handle(message);
      }
    } catch {
      // ignore malformed fixture input
    }
  }
});
