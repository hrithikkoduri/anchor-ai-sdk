/**
 * Sandbox lifecycle (openSandbox / releaseSandbox) — the dogfooded path Sailor
 * uses: adopt-with-fallback on open, destroy-by-handle on release.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSandbox } from "../../src/sandbox/local.js";
import {
  openSandbox,
  releaseSandbox,
  type CreateSandboxOptions,
  type SandboxSpec,
} from "../../src/sandbox/index.js";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

describe("sandbox lifecycle", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "anchor-life-"));
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });
  const options = (): CreateSandboxOptions => ({
    local: { rootDir, quiet: true },
  });

  it("adopts a retained sandbox and skips the fresh path", async () => {
    const spec: SandboxSpec = { retain: true };
    const first = await openSandbox({ ...options(), spec });
    await first.exec(`echo hi > f.txt`);
    await first.destroy(); // retained — the directory stays

    const resumed = await openSandbox({
      ...options(),
      spec,
      adopt: { id: first.id, backend: "local" },
    });
    expect(resumed.id).toBe(first.id);
    const read = await resumed.exec("cat f.txt");
    expect(read.stdout.trim()).toBe("hi");
    await resumed.destroy();
  });

  it("falls back to fresh and reports a missing retained sandbox", async () => {
    const gone: string[] = [];
    const sandbox = await openSandbox({
      ...options(),
      spec: {},
      adopt: { id: "sb-anchor-nope", backend: "local" },
      onRetainedGone: (handle) => {
        gone.push(handle.id);
      },
    });
    expect(gone).toEqual(["sb-anchor-nope"]);
    expect(sandbox.id).not.toBe("sb-anchor-nope");
    await sandbox.destroy();
  });

  it("retries fallbackSpec when the ref is unusable", async () => {
    // A real repo: the clone succeeds, the checkout of the missing ref fails.
    const origin = path.join(rootDir, "origin-src");
    await mkdir(origin, { recursive: true });
    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "user.name", "fixture");
    git(origin, "config", "user.email", "fixture@localhost");
    await writeFile(path.join(origin, "README.md"), "v1\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "v1");

    const refs: string[] = [];
    const sandbox = await openSandbox({
      ...options(),
      spec: { repoUrl: origin, ref: "missing-branch" },
      fallbackSpec: { repoUrl: origin },
      onRefUnusable: (ref) => {
        refs.push(ref);
      },
    });
    expect(refs).toEqual(["missing-branch"]);
    const branch = await sandbox.exec("git branch --show-current");
    expect(branch.stdout.trim()).toBe("main");
    await sandbox.destroy();
  });

  it("releases a retained sandbox by handle alone", async () => {
    const spec: SandboxSpec = { retain: true };
    const sandbox = await openSandbox({ ...options(), spec });
    await sandbox.exec("echo keep > f.txt");
    await sandbox.destroy(); // retained on disk

    await releaseSandbox({ id: sandbox.id, backend: "local" }, options());
    const ghost = new LocalSandbox(
      { adopt: sandbox.id },
      {
        rootDir,
        quiet: true,
      },
    );
    await expect(ghost.start()).rejects.toThrow(/no workspace/);
  });
});
