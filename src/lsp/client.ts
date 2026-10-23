/**
 * A small JSON-RPC peer over a Sandbox ProcessHandle. It owns request ids,
 * pending responses, notifications, and server-initiated requests; protocol
 * methods live above it.
 */
import type { ProcessHandle } from "../sandbox/types.js";
import {
  encodeLspMessage,
  LspFramer,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./protocol.js";

export interface LspPeerOptions {
  onNotification?: (message: JsonRpcMessage) => void;
  /** Return a result, or `undefined` to answer `null`. */
  onRequest?: (message: JsonRpcMessage) => Promise<unknown> | unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspPeer {
  private readonly framer = new LspFramer();
  private readonly pending = new Map<JsonRpcId, Pending>();
  private nextId = 1;
  private closed = false;
  private readonly stderr: string[] = [];

  constructor(
    private readonly process: ProcessHandle,
    private readonly opts: LspPeerOptions = {},
  ) {}

  start(): void {
    void this.readStdout();
    void this.readStderr();
    void this.process.wait().then(
      () => this.failAll(new Error("LSP process exited")),
      (error: unknown) =>
        this.failAll(error instanceof Error ? error : new Error(String(error))),
    );
  }

  async request(
    method: string,
    params?: unknown,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.closed) throw new Error("LSP connection is closed");
    const id = this.nextId++;
    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.process.write(encodeLspMessage(message));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
    return promise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new Error("LSP connection is closed");
    await this.process.write(
      encodeLspMessage({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      }),
    );
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    if (this.closed) return;
    await this.process.write(
      encodeLspMessage({ jsonrpc: "2.0", id, result }),
    );
  }

  async respondError(
    id: JsonRpcId,
    code: number,
    message: string,
  ): Promise<void> {
    if (this.closed) return;
    await this.process.write(
      encodeLspMessage({ jsonrpc: "2.0", id, error: { code, message } }),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("LSP connection closed"));
    await this.process.kill("SIGTERM").catch(() => false);
  }

  private async readStdout(): Promise<void> {
    try {
      for await (const chunk of this.process.stdout) {
        for (const message of this.framer.push(chunk)) {
          await this.dispatch(message);
        }
      }
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async readStderr(): Promise<void> {
    try {
      for await (const chunk of this.process.stderr) {
        this.stderr.push(Buffer.from(chunk).toString("utf8"));
        if (this.stderr.length > 20) this.stderr.shift();
      }
    } catch {
      // stderr is diagnostics only.
    }
  }

  private async dispatch(message: JsonRpcMessage): Promise<void> {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            `${message.error.message}${message.error.data ? ` (${JSON.stringify(message.error.data)})` : ""}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      try {
        const result = await this.opts.onRequest?.(message);
        await this.respond(message.id, result ?? null);
      } catch (error) {
        await this.respondError(
          message.id,
          -32603,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    if (message.method) this.opts.onNotification?.(message);
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(
          `${error.message}${this.stderr.length ? `: ${this.stderr.join("").trim().slice(-500)}` : ""}`,
        ),
      );
    }
    this.pending.clear();
  }
}
