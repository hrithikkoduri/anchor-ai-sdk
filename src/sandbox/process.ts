/**
 * Provider-neutral persistent process handle built on a host ChildProcess.
 * Local uses it directly; Docker uses it for the `docker exec -i` side. The
 * handle owns stream backpressure, deadline/abort handling, process-group
 * termination, and wait().
 */
import type { ChildProcess } from "node:child_process";
import type { ProcessHandle, ProcessOptions } from "./types.js";

class ByteQueue implements AsyncIterable<Uint8Array> {
  private readonly values: Uint8Array[] = [];
  private waiters: Array<(value: Uint8Array | undefined) => void> = [];
  private closed = false;

  push(value: Uint8Array): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }

  private next(): Promise<Uint8Array | undefined> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      const value = await this.next();
      if (value === undefined) return;
      yield value;
    }
  }
}

export interface ChildProcessHandleOptions {
  /** Kill the whole process group (local detached child). */
  processGroup?: boolean;
  /** Provider-specific guest cleanup, best-effort. */
  killGuest?: () => Promise<void>;
  onClose?: () => void;
}

export class ChildProcessHandle implements ProcessHandle {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  private readonly out = new ByteQueue();
  private readonly err = new ByteQueue();
  private readonly exitPromise: Promise<{
    exitCode: number;
    signal?: string;
    timedOut: boolean;
  }>;
  private exit:
    | { exitCode: number; signal?: string; timedOut: boolean }
    | undefined;
  private timedOut = false;
  private killed = false;
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onAbort: (() => void) | undefined;

  constructor(
    readonly id: string,
    private readonly child: ChildProcess,
    opts: ProcessOptions & ChildProcessHandleOptions = {},
  ) {
    this.stdout = this.out;
    this.stderr = this.err;
    this.child.stdout?.on("data", (chunk: Buffer) => this.out.push(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => this.err.push(chunk));
    this.child.on("close", (code, signal) => {
      this.out.close();
      this.err.close();
      this.settle(code ?? -1, signal ?? undefined);
    });

    this.exitPromise = new Promise((resolve, reject) => {
      this.child.once("error", (error) => {
        this.out.close();
        this.err.close();
        reject(error);
      });
      this.resolveWait = resolve;
    });

    const timeoutSecs = opts.timeoutSecs ?? 3600;
    this.timer = setTimeout(() => {
      this.timedOut = true;
      void this.kill("SIGKILL");
    }, timeoutSecs * 1000);

    if (opts.signal) {
      const abort = () => {
        this.timedOut = true;
        void this.kill("SIGKILL");
      };
      this.onAbort = abort;
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }

    this.processGroup = opts.processGroup === true;
    this.killGuest = opts.killGuest;
    this.onClose = opts.onClose;
  }

  private resolveWait:
    | ((value: { exitCode: number; signal?: string; timedOut: boolean }) => void)
    | undefined;
  private readonly processGroup: boolean;
  private readonly killGuest: (() => Promise<void>) | undefined;
  private readonly onClose: (() => void) | undefined;

  private settle(exitCode: number, signal?: string): void {
    if (this.exit) return;
    this.exit = {
      exitCode,
      ...(signal ? { signal } : {}),
      timedOut: this.timedOut,
    };
    if (this.timer) clearTimeout(this.timer);
    this.onClose?.();
    this.resolveWait?.(this.exit);
  }

  async write(data: string | Uint8Array): Promise<void> {
    if (!this.child.stdin || this.child.stdin.destroyed) {
      throw new Error(`process ${this.id} has no writable stdin`);
    }
    const accepted = this.child.stdin.write(data);
    if (!accepted) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          this.child.stdin?.off("drain", onDrain);
          this.child.stdin?.off("error", onError);
        };
        this.child.stdin?.once("drain", onDrain);
        this.child.stdin?.once("error", onError);
      });
    }
  }

  async endInput(): Promise<void> {
    if (!this.child.stdin || this.child.stdin.destroyed) return;
    await new Promise<void>((resolve) => {
      this.child.stdin?.end(resolve);
    });
  }

  wait(): Promise<{ exitCode: number; signal?: string; timedOut: boolean }> {
    return this.exitPromise;
  }

  async kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<boolean> {
    if (this.exit) return false;
    this.killed = true;
    if (this.processGroup && this.child.pid) {
      try {
        process.kill(-this.child.pid, signal);
      } catch {
        this.child.kill(signal);
      }
    } else {
      this.child.kill(signal);
    }
    await this.killGuest?.().catch(() => undefined);
    return true;
  }

  /** True once kill() was requested. */
  get wasKilled(): boolean {
    return this.killed;
  }
}
