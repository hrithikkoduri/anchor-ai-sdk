/**
 * Idempotent, lock-tolerant git configuration on the E2B adopt path.
 *
 * Two openers can adopt the same sandbox and both run start() → configureGit.
 * Writing config unconditionally made the loser fail with "could not lock
 * config file .git/config: File exists", which used to be misread as "sandbox
 * gone". Config now is written only when it differs, and a lock is retried.
 */
import { describe, expect, it } from "vitest";
import { E2BSandbox } from "../../src/sandbox/e2b/index.js";

interface FakeClient {
  sandboxId: string;
  getInfo(): Promise<unknown>;
  setTimeout(ms: number): Promise<void>;
  pause(): Promise<void>;
  kill(): Promise<void>;
  commands: { run(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> };
}

/** `git config --get 'user.name'` (read) vs `git config 'user.name' …` (write). */
const readsKey = (command: string, key: string) =>
  command.includes("--get") && command.includes(key);
const writesKey = (command: string, key: string) =>
  command.includes("config") && !command.includes("--get") && command.includes(key);

function fakeClient(
  onGitConfig: (command: string) => { exitCode: number; stdout: string; stderr: string } | undefined,
): { client: FakeClient; seen: string[] } {
  const seen: string[] = [];
  const client: FakeClient = {
    sandboxId: "sb-1",
    getInfo: async () => ({ metadata: { anchorWorkspace: "/home/user/repo" } }),
    setTimeout: async () => undefined,
    pause: async () => undefined,
    kill: async () => undefined,
    commands: {
      run: async (command: string) => {
        seen.push(command);
        if (command.includes("test -d") && command.includes(".git"))
          return { exitCode: 0, stdout: "", stderr: "" };
        return onGitConfig(command) ?? { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
  return { client, seen };
}

function sandbox(client: FakeClient): E2BSandbox {
  return new E2BSandbox(
    { adopt: "sb-1", workspacePath: "/home/user/repo" },
    {
      quiet: true,
      clientFactory: {
        create: async () => client as never,
        connect: async () => client as never,
      },
    },
  );
}

describe("E2BSandbox.configureGit", () => {
  it("skips a value that already matches (no write, no lock)", async () => {
    const { client, seen } = fakeClient((command) =>
      readsKey(command, "user.name") ? { exitCode: 0, stdout: "anchor\n", stderr: "" } : undefined,
    );
    const configured = sandbox(client);
    await configured.start();
    expect(seen.some((c) => writesKey(c, "user.name"))).toBe(false);
    await configured.destroy();
  });

  it("retries a transient config lock instead of failing the open", async () => {
    let writes = 0;
    const { client } = fakeClient((command) => {
      if (readsKey(command, "user.name")) return { exitCode: 0, stdout: "", stderr: "" };
      if (writesKey(command, "user.name")) {
        writes += 1;
        return writes === 1
          ? { exitCode: 128, stdout: "", stderr: "error: could not lock config file .git/config: File exists" }
          : { exitCode: 0, stdout: "", stderr: "" };
      }
      return undefined;
    });
    const configured = sandbox(client);
    await configured.start();
    expect(writes).toBe(2); // the lock was retried, not fatal
    await configured.destroy();
  });
});
