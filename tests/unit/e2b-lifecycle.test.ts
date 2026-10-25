/**
 * E2B lifecycle without the network. The adapter's create/connect calls are
 * injectable (`clientFactory`), so start/adopt/destroy/fork can be asserted
 * offline; the live conformance suite covers the same paths for real.
 */
import { describe, expect, it, vi } from "vitest";
import type { Sandbox as E2BClient } from "e2b";
import {
  E2BSandbox,
  type E2BClientFactory,
} from "../../src/sandbox/e2b/index.js";

type RunResult = { exitCode?: number; stdout?: string; stderr?: string };

function fakeClient(opts: {
  sandboxId?: string;
  metadata?: Record<string, string>;
  run?: (command: string) => RunResult;
} = {}) {
  const calls: string[] = [];
  const killed: string[] = [];
  const paused: string[] = [];
  const client = {
    sandboxId: opts.sandboxId ?? "sb-fake",
    commands: {
      run: async (command: string) => {
        calls.push(command);
        const result = opts.run?.(command) ?? {};
        return {
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      },
    },
    getHost: (port: number) => `sb-fake-${port}.e2b.test`,
    getInfo: async () => ({ metadata: opts.metadata ?? {} }),
    kill: async () => {
      killed.push("kill");
      return true;
    },
    pause: async () => {
      paused.push("pause");
      return true;
    },
    fork: async () => {
      throw new Error("fork not stubbed on this client");
    },
  };
  return { client: client as unknown as E2BClient, calls, killed, paused };
}

function factory(client: E2BClient): E2BClientFactory {
  return {
    create: async () => client,
    connect: async () => client,
  };
}

describe("e2b lifecycle (fake client)", () => {
  it("prepares a pre-provisioned workspace and starts", async () => {
    const fake = fakeClient();
    const sandbox = new E2BSandbox(
      { workspacePath: "/testbed" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();

    // Commands arrive wrapped: `cd … && timeout … bash -c '<command>'`.
    expect(fake.calls[0]).toContain("test -d");
    expect(fake.calls[0]).toContain("/testbed");
    expect(fake.calls[1]).toContain("/testbed/.git");
    expect(fake.calls.some((c) => c.includes("user.name"))).toBe(true);
    expect(fake.killed).toHaveLength(0);
  });

  it("exposes a guest port as a public HTTPS URL", async () => {
    const fake = fakeClient();
    const sandbox = new E2BSandbox(
      { workspacePath: "/testbed" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();

    await expect(sandbox.exposePort(3000)).resolves.toEqual({
      url: "https://sb-fake-3000.e2b.test",
      port: 3000,
    });
  });

  it("rejects invalid preview ports", async () => {
    const fake = fakeClient();
    const sandbox = new E2BSandbox(
      { workspacePath: "/testbed" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();

    for (const port of [0, 65_536, 1.5, -1]) {
      await expect(sandbox.exposePort(port)).rejects.toThrow(/1\.\.65535/);
    }
  });

  it("kills the sandbox it created when start fails", async () => {
    const fake = fakeClient({
      run: (command) =>
        command.includes("/.git") ? { exitCode: 1 } : { exitCode: 0 },
    });
    const sandbox = new E2BSandbox(
      { workspacePath: "/testbed" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await expect(sandbox.start()).rejects.toThrow(/not a git repository/);
    expect(fake.killed).toHaveLength(1);
  });

  it("never kills an adopted sandbox when start fails", async () => {
    const fake = fakeClient({
      sandboxId: "sb-adopted",
      run: (command) =>
        command.includes("/.git") ? { exitCode: 1 } : { exitCode: 0 },
    });
    const sandbox = new E2BSandbox(
      { adopt: "sb-adopted" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await expect(sandbox.start()).rejects.toThrow(/no workspace/);
    expect(fake.killed).toHaveLength(0);
  });

  it("restores workspace and scratch from the sandbox's metadata on adopt", async () => {
    const fake = fakeClient({
      sandboxId: "sb-adopted",
      metadata: { anchorWorkspace: "/srv/repo", anchorScratch: "/srv/scratch" },
    });
    const sandbox = new E2BSandbox(
      { adopt: "sb-adopted" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();
    expect(sandbox.workspace).toBe("/srv/repo");
    expect(sandbox.scratch).toBe("/srv/scratch");
    expect(fake.calls[0]).toContain("/srv/repo");
    expect(fake.calls[0]).toContain(".git");
  });

  it("explains the template/image mistake when create fails", async () => {
    const sandbox = new E2BSandbox(
      { image: "swebench/sweb.eval.x86_64.django:latest" },
      {
        quiet: true,
        clientFactory: {
          create: async () => {
            throw new Error("template not found");
          },
          connect: async () => {
            throw new Error("unused");
          },
        },
      },
    );
    await expect(sandbox.start()).rejects.toThrow(
      /E2B boots templates, not Docker images/,
    );
  });

  it("pauses a retained sandbox instead of killing it, and is idempotent", async () => {
    const fake = fakeClient();
    const sandbox = new E2BSandbox(
      { workspacePath: "/testbed", retain: true },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();
    await sandbox.destroy();
    await sandbox.destroy();
    expect(fake.paused).toHaveLength(1);
    expect(fake.killed).toHaveLength(0);
  });

  it("mints one git token for many commands", async () => {
    let minted = 0;
    const fake = fakeClient();
    const sandbox = new E2BSandbox(
      {
        workspacePath: "/testbed",
        git: {
          token: async () => {
            minted++;
            return "tok";
          },
        },
      },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();
    await sandbox.exec("echo one");
    await sandbox.exec("echo two");
    expect(minted).toBe(1);
  });

  it("forks and resets the child to the requested commit", async () => {
    const child = fakeClient({ sandboxId: "sb-child" });
    const parent = fakeClient();
    const parentClient = parent.client as unknown as {
      fork: () => Promise<unknown[]>;
    };
    parentClient.fork = async () => [child.client];

    const sandbox = new E2BSandbox(
      { workspacePath: "/testbed" },
      { quiet: true, clientFactory: factory(parent.client) },
    );
    await sandbox.start();
    const forked = await sandbox.fork("abc123");

    expect(forked.id).toBe("sb-child");
    const reset = child.calls.find(
      (c) => c.includes("git checkout") && c.includes("git clean -fd"),
    );
    expect(reset).toBeDefined();
    expect(reset).toContain("abc123");
  });
});

describe("e2b lifetime (fake client)", () => {
  function recording() {
    const fake = fakeClient();
    const renewals: number[] = [];
    (fake.client as unknown as { setTimeout: (ms: number) => Promise<void> }).setTimeout = async (ms: number) => {
      renewals.push(ms);
    };
    const created: Array<Record<string, unknown>> = [];
    const factory: E2BClientFactory = {
      create: async (_template, opts) => {
        created.push(opts as Record<string, unknown>);
        return fake.client;
      },
      connect: async () => fake.client,
    };
    return { fake, renewals, created, factory };
  }

  it("a retained sandbox pauses when its time runs out; a throwaway one does not ask to", async () => {
    const kept = recording();
    const retained = new E2BSandbox({ workspacePath: "/testbed", retain: true }, { quiet: true, clientFactory: kept.factory });
    await retained.start();
    expect(kept.created[0]?.lifecycle).toEqual({ onTimeout: "pause" });
    await retained.destroy();

    const once = recording();
    const throwaway = new E2BSandbox({ workspacePath: "/testbed" }, { quiet: true, clientFactory: once.factory });
    await throwaway.start();
    expect(once.created[0]?.lifecycle).toBeUndefined();
    await throwaway.destroy();
  });

  it("renews its lifetime while in use, and stops once destroyed", async () => {
    vi.useFakeTimers();
    try {
      const run = recording();
      const sandbox = new E2BSandbox(
        { workspacePath: "/testbed", retain: true },
        { quiet: true, clientFactory: run.factory, timeoutMs: 60 * 60_000 },
      );
      await sandbox.start();
      expect(run.renewals).toHaveLength(0);
      // Every ten minutes (a third of an hour, capped at ten), for the whole lifetime again.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(run.renewals).toEqual([60 * 60_000]);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(run.renewals).toHaveLength(3);
      await sandbox.destroy();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(run.renewals).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
