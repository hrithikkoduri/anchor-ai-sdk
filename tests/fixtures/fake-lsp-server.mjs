/* Minimal stdio LSP fixture for the lsp client test. */
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(message) {
  if (message.id !== undefined && message.method) {
    if (message.method === "initialize") {
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
      } else {
        handle(message);
      }
    } catch {
      // ignore malformed fixture input
    }
  }
});
