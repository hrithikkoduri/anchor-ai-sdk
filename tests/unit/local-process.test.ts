import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { local } from "../../src/sandbox/local/index.js";

const roots: string[] = [];
async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), "anchor-process-"));
  roots.push(root);
  const box = local({ rootDir: root, quiet: true }).create({});
  await box.start();
  return box;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += Buffer.from(chunk).toString();
  return text;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("LocalSandbox.openProcess", () => {
  it("streams stdin to stdout and returns the exit code", async () => {
    const box = await sandbox();
    const handle = await box.openProcess!("cat", []);
    await handle.write("hello");
    await handle.endInput();
    const output = await collect(handle.stdout);
    const exit = await handle.wait();

    expect(output).toBe("hello");
    expect(exit.exitCode).toBe(0);
    expect(exit.timedOut).toBe(false);
    await box.destroy();
  });

  it("kills a process that ignores stdin", async () => {
    const box = await sandbox();
    const handle = await box.openProcess!("sleep", ["30"]);
    await handle.kill("SIGKILL");
    const exit = await handle.wait();
    expect(exit.exitCode).not.toBe(0);
    await box.destroy();
  });

  it("times out and reports the deadline", async () => {
    const box = await sandbox();
    const handle = await box.openProcess!("sleep", ["30"], {
      timeoutSecs: 1,
    });
    const exit = await handle.wait();
    expect(exit.timedOut).toBe(true);
    await box.destroy();
  });

  it("closes open processes when the sandbox is destroyed", async () => {
    const box = await sandbox();
    const handle = await box.openProcess!("sleep", ["30"]);
    await box.destroy();
    const exit = await handle.wait();
    expect(exit.exitCode).not.toBe(0);
  });
});
