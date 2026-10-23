/**
 * LSP wire framing, deliberately kept in the optional `lsp` entry point.
 * The sandbox only knows bytes; JSON-RPC framing belongs here, not in core.
 */

export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Encode one LSP/JSON-RPC message with its Content-Length header. */
export function encodeLspMessage(message: JsonRpcMessage): Uint8Array {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

/** Incremental parser for LSP's Content-Length framing. */
export class LspFramer {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): JsonRpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const out: JsonRpcMessage[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return out;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // A malformed stream cannot be resynchronized reliably.
        this.buffer = Buffer.alloc(0);
        return out;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return out;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        out.push(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Ignore one malformed body; the next frame still has a length header.
      }
    }
  }
}
