/** Small host-command runner for image builders. Keeps output streaming and
 * applies the same deadline/abort discipline as the sandbox adapters. */
import { spawn } from "node:child_process";

export interface CommandRunOptions {
  timeoutSecs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export async function runCommand(
  command: string,
  args: string[],
  opts: CommandRunOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      (opts.timeoutSecs ?? 1800) * 1000,
    );
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-16_384);
      opts.log?.(text);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const hint =
        error.code === "ENOENT"
          ? ` (not found on PATH; install ${command} or point the CLI at it)`
          : "";
      reject(new Error(`${command} ${args[0] ?? ""} failed: ${error.message}${hint}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (timedOut) {
        reject(new Error(`${command} ${args[0] ?? ""} timed out`));
        return;
      }
      if (aborted) {
        reject(new Error(`${command} ${args[0] ?? ""} aborted`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `${command} ${args[0] ?? ""} exited ${code ?? "unknown"}:\n${output.trim()}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}
