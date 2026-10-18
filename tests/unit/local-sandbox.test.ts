/**
 * LocalSandbox conformance tests.
 *
 * These prove the tool-call contract (src/sandbox/types.ts):
 *   1. exec captures output + exit codes faithfully
 *   2. commands are self-contained — no state leaks between execs
 *   3. a hung command is actually KILLED at its deadline
 *   4. secrets travel as env vars, per call and via spec
 *   5. checkpoints are real git commits with a sha to resume/fork from
 *   6. destroy is idempotent; keep preserves the workspace for debugging
 *   7. a repo can be cloned (with ref) or copied without touching the original
 *
 * The same scenario file will be parameterized over the Heyo backend in
 * step 4, so both backends provably behave identically.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSandbox } from "../../src/sandbox/local.js";
import type { SandboxSpec } from "../../src/sandbox/types.js";

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** Run a git command in `cwd` and fail loudly if it fails (test fixtures only). */
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

describe("LocalSandbox", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "harness-sbx-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const make = (spec: SandboxSpec = {}) => new LocalSandbox(spec, { rootDir, quiet: true });

  it("captures stdout, stderr, and exit codes faithfully", async () => {
    const sb = make();
    await sb.start();
    try {
      const r = await sb.exec(`echo out && echo err >&2 && exit 7`);
      expect(r.stdout).toContain("out");
      expect(r.stderr).toContain("err");
      expect(r.output).toContain("out");
      expect(r.output).toContain("err");
      expect(r.exitCode).toBe(7);
      expect(r.timedOut).toBe(false);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await sb.destroy();
    }
  });

  it("commands are self-contained — no state leaks between execs", async () => {
    const sb = make();
    await sb.start();
    try {
      await sb.exec(`export LEAK=1 && cd /tmp`);
      const r = await sb.exec(`echo "leak=\${LEAK:-none}" && pwd`);
      expect(r.stdout).toContain("leak=none");
      // Default cwd is the workspace (compare resolved paths — macOS /tmp is a symlink)
      const pwd = r.stdout.trim().split("\n").pop();
      expect(await realpath(pwd!)).toBe(await realpath(sb.workspace));
    } finally {
      await sb.destroy();
    }
  });

  it("actually kills a hung command at its deadline", async () => {
    const sb = make();
    await sb.start();
    try {
      const t0 = Date.now();
      const r = await sb.exec(`sleep 30`, { timeoutSecs: 1 });
      const elapsed = Date.now() - t0;
      expect(r.timedOut).toBe(true);
      expect([124, 137]).toContain(r.exitCode); // killed by SIGTERM (124) or SIGKILL (137)
      expect(elapsed).toBeLessThan(8_000); // killed, not waited out
    } finally {
      await sb.destroy();
    }
  }, 15_000);

  it("passes secrets as env vars — per call, merged over spec env", async () => {
    const sb = make({ env: { BASE_VAR: "base" } });
    await sb.start();
    try {
      const r = await sb.exec(`echo "$BASE_VAR/$EXTRA_VAR"`, { env: { EXTRA_VAR: "extra" } });
      expect(r.stdout.trim()).toBe("base/extra");
    } finally {
      await sb.destroy();
    }
  });

  it("checkpoint creates a real commit and returns its sha", async () => {
    const sb = make();
    await sb.start();
    try {
      await sb.exec(`echo "hello" > work.txt`);
      const cp = await sb.checkpoint("after reproduce");
      expect(cp.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(cp.message).toBe("after reproduce");

      const log = await sb.exec(`git log -1 --format=%s`);
      expect(log.stdout.trim()).toBe("after reproduce");
      const head = await sb.exec(`git rev-parse HEAD`);
      expect(head.stdout.trim()).toBe(cp.sha);

      // A checkpoint with no changes still yields a valid resume point.
      const cp2 = await sb.checkpoint("no-op checkpoint");
      expect(cp2.sha).not.toBe(cp.sha);
    } finally {
      await sb.destroy();
    }
  });

  it("destroy removes the workspace, is idempotent, and blocks further exec", async () => {
    const sb = make();
    await sb.start();
    await sb.destroy();
    await sb.destroy(); // second call is a no-op, not an error
    expect(await exists(sb.root)).toBe(false);
    await expect(sb.exec("echo hi")).rejects.toThrow(/destroyed/);
  });

  it("keep: true preserves the workspace for debugging", async () => {
    const sb = make({ keep: true });
    await sb.start();
    await sb.destroy();
    expect(await exists(sb.root)).toBe(true);
  });

  it("clones a repo (with ref checkout) from a git URL", async () => {
    // Fixture repo: main with one commit + a branch with another.
    const origin = path.join(rootDir, "origin.git-src");
    await mkdir(origin, { recursive: true });
    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "user.name", "fixture");
    git(origin, "config", "user.email", "fixture@localhost");
    await writeFile(path.join(origin, "README.md"), "v1\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "v1");
    git(origin, "checkout", "-qb", "feature");
    await writeFile(path.join(origin, "README.md"), "v1+feature\n");
    git(origin, "commit", "-qam", "feature work");
    git(origin, "checkout", "-q", "main");

    const sb = make({ repoUrl: origin, ref: "feature" });
    await sb.start();
    try {
      const r = await sb.exec(`cat README.md`);
      expect(r.stdout).toContain("v1+feature");
      const branch = await sb.exec(`git branch --show-current`);
      expect(branch.stdout.trim()).toBe("feature");
    } finally {
      await sb.destroy();
    }
  });

  it("hasChangesFrom compares TREES — checkpoint-only changes are not new work", async () => {
    // An origin with one commit on main.
    const origin = path.join(rootDir, "origin-changes.git-src");
    await mkdir(origin, { recursive: true });
    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "user.name", "fixture");
    git(origin, "config", "user.email", "fixture@localhost");
    await writeFile(path.join(origin, "README.md"), "v1\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "v1");

    const sb = make({ repoUrl: origin });
    await sb.start();
    try {
      expect(await sb.hasChangesFrom("origin/main")).toBe(false);

      // THE LOOP TRAP, sealed at the interface: a checkpoint adds a commit
      // but no content — it must NOT read as new work (2026-10-18).
      await sb.checkpoint("after verify");
      expect(await sb.hasChangesFrom("origin/main")).toBe(false);

      // Uncommitted working-tree changes count.
      await sb.exec(`echo "more" >> README.md`);
      expect(await sb.hasChangesFrom("origin/main")).toBe(true);

      // The ref is refreshed before comparing: someone else pushed.
      await sb.exec("git reset -q --hard HEAD"); // back to v1 locally…
      await writeFile(path.join(origin, "README.md"), "v2\n");
      git(origin, "commit", "-qam", "v2"); // …while main moves to v2
      expect(await sb.hasChangesFrom("origin/main")).toBe(true); // fetched, not stale

      // A ref that can't be resolved fails open.
      expect(await sb.hasChangesFrom("origin/does-not-exist")).toBe(true);
    } finally {
      await sb.destroy();
    }
  });

  it("forks a sandbox at a checkpoint — independent copies of that state", async () => {
    const sb = make();
    await sb.start();
    try {
      await sb.exec("echo v1 > f.txt");
      const cp = await sb.checkpoint("v1");

      await sb.exec("echo v2 > f.txt"); // the original moves on

      const forked = await sb.fork(cp.sha);
      try {
        const forkedRead = await forked.exec("cat f.txt");
        expect(forkedRead.stdout.trim()).toBe("v1");

        // The fork is independent: edits there don't touch the original.
        await forked.exec("echo forked > f.txt");
        const originalRead = await sb.exec("cat f.txt");
        expect(originalRead.stdout.trim()).toBe("v2");
      } finally {
        await forked.destroy();
      }
    } finally {
      await sb.destroy();
    }
  });

  it("copies a localPath repo without mutating the original", async () => {
    const fixture = path.join(rootDir, "fixture");
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, "file.txt"), "original\n");

    const sb = make({ localPath: fixture });
    await sb.start();
    try {
      await sb.exec(`echo "edited" >> file.txt`);
      await sb.checkpoint("edit");
      const inSandbox = await sb.exec(`cat file.txt`);
      expect(inSandbox.stdout).toContain("edited");
      // The original is untouched.
      expect(await readFile(path.join(fixture, "file.txt"), "utf8")).toBe("original\n");
    } finally {
      await sb.destroy();
    }
  });
});
