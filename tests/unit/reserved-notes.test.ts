/**
 * The reserved notes path: hidden from git status/diffs, carried by
 * checkpoints, and idempotent to prepare. This is the durability half of the
 * memory slice (spill covers the ephemeral half).
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkpointVia,
  reservedScratchPrepCommand,
  type GitAccess,
} from "../../src/sandbox/git.js";
import { LocalSandbox } from "../../src/sandbox/local/index.js";

function fakeAccess() {
  const calls: string[] = [];
  const access: GitAccess = {
    git: async (args) => {
      calls.push(`git ${args.join(" ")}`);
      return args[0] === "rev-parse" ? `${"a".repeat(40)}\n` : "";
    },
    shell: async (command) => {
      calls.push(`shell ${command}`);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        output: "",
        timedOut: false,
        durationMs: 1,
      };
    },
  };
  return { access, calls };
}

describe("reserved notes path", () => {
  it("checkpoint force-adds .anchor/notes.md before committing", async () => {
    const { access, calls } = fakeAccess();
    const cp = await checkpointVia(access, "test checkpoint");
    expect(cp.sha).toBe("a".repeat(40));

    const forceIndex = calls.findIndex((call) =>
      call.includes("git add -f .anchor/notes.md"),
    );
    const commitIndex = calls.findIndex((call) =>
      call.startsWith("git commit"),
    );
    expect(forceIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(forceIndex);
  });

  it("notes stay out of status, ride checkpoints, and prep is idempotent", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anchor-notes-"));
    const sandbox = new LocalSandbox({}, { rootDir, quiet: true });
    await sandbox.start();
    try {
      // The agent writes its notes (the dir exists — prep created it).
      await sandbox.exec(
        `printf '# notes\\nverified: nothing yet\\n' > .anchor/notes.md`,
      );

      const statusBefore = await sandbox.exec("git status --short");
      expect(statusBefore.stdout.trim()).toBe(""); // hidden from status

      const cp = await sandbox.checkpoint("with notes");
      expect(cp.sha).toMatch(/^[0-9a-f]{40}$/);

      const stat = await sandbox.exec("git show --stat --format= HEAD");
      expect(stat.stdout).toContain(".anchor/notes.md"); // carried by the commit

      const statusAfter = await sandbox.exec("git status --short");
      expect(statusAfter.stdout.trim()).toBe(""); // still clean

      // Prep is idempotent: a second run adds no duplicate exclude line.
      await sandbox.exec(reservedScratchPrepCommand());
      const excludes = await sandbox.exec(
        "grep -c '.anchor/' .git/info/exclude || true",
      );
      expect(excludes.stdout.trim()).toBe("1");
    } finally {
      await sandbox.destroy();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
