/**
 * E2B lifecycle without the network. The adapter's create/connect calls are
 * injectable (`clientFactory`), so start/adopt/destroy/fork can be asserted
 * offline; the live conformance suite covers the same paths for real.
 */
import { describe, expect, it, vi } from "vitest";
import { SandboxNotFoundError, type Sandbox as E2BClient } from "e2b";
import {
  E2BSandbox,
  e2b,
  type E2BClientFactory,
} from "../../src/sandbox/e2b/index.js";
import { SandboxGoneError, WorkspaceUnavailableError } from "../../src/sandbox/types.js";

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
      { quiet: true, clientFactory: factory(fake.client), adoptBackoffMs: 0 },
    );
    await expect(sandbox.start()).rejects.toThrow(/could not be confirmed/);
    expect(fake.killed).toHaveLength(0);
  });

  it("retries a failing workspace check, then fails as unavailable — never gone", async () => {
    let connects = 0;
    const fake = fakeClient({
      sandboxId: "sb-adopted",
      run: (command) =>
        command.includes("/.git") ? { exitCode: 1 } : { exitCode: 0 },
    });
    const sandbox = new E2BSandbox(
      { adopt: "sb-adopted" },
      {
        quiet: true,
        adoptAttempts: 3,
        adoptBackoffMs: 0,
        clientFactory: {
          create: async () => fake.client,
          connect: async () => {
            connects += 1;
            return fake.client;
          },
        },
      },
    );
    const error = await sandbox.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WorkspaceUnavailableError);
    expect(error).not.toBeInstanceOf(SandboxGoneError);
    expect(connects).toBe(3);
    expect(fake.calls.filter((c) => c.includes("/.git"))).toHaveLength(3);
    expect(e2b({ quiet: true }).isGone!(error)).toBe(false);
  });

  it("adopts once a mid-resume workspace check starts answering", async () => {
    let checks = 0;
    const fake = fakeClient({
      sandboxId: "sb-adopted",
      run: (command) => {
        if (!command.includes("test -d")) return { exitCode: 0 };
        checks += 1;
        // A transport failure first (the guest is still pausing/resuming).
        return checks < 3 ? { exitCode: -1 } : { exitCode: 0 };
      },
    });
    const sandbox = new E2BSandbox(
      { adopt: "sb-adopted" },
      { quiet: true, adoptBackoffMs: 0, clientFactory: factory(fake.client) },
    );
    await sandbox.start();
    expect(sandbox.id).toBe("sb-adopted");
    expect(checks).toBe(3);
  });

  it("is gone only when E2B says the sandbox does not exist", async () => {
    const sandbox = new E2BSandbox(
      { adopt: "sb-dead" },
      {
        quiet: true,
        adoptBackoffMs: 0,
        clientFactory: {
          create: async () => {
            throw new Error("unused");
          },
          connect: async () => {
            throw new SandboxNotFoundError("sandbox sb-dead not found");
          },
        },
      },
    );
    const error = await sandbox.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SandboxGoneError);
    const provider = e2b({ quiet: true });
    expect(provider.isGone!(error)).toBe(true);
    // A git message mentioning "not found" is not the control plane talking.
    expect(provider.isGone!(new Error("fatal: remote ref not found"))).toBe(false);
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

  it("destroy() of a retained sandbox neither pauses nor kills it, and is idempotent", async () => {
    const fake = fakeClient();
    const sandbox = new E2BSandbox(
      { workspacePath: "/testbed", retain: true },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();
    await sandbox.destroy();
    await sandbox.destroy();
    // Another run may share it: only the consumer's suspend() pauses it.
    expect(fake.paused).toHaveLength(0);
    expect(fake.killed).toHaveLength(0);
  });

  it("provider.suspend pauses by id; already-gone is not an error", async () => {
    const paused: string[] = [];
    const fake = fakeClient();
    const provider = e2b({
      quiet: true,
      clientFactory: {
        ...factory(fake.client),
        pause: async (id) => {
          if (id === "sb-gone") throw new SandboxNotFoundError("not found");
          paused.push(id);
          return true;
        },
      },
    });
    await provider.suspend!({ id: "sb-1", backend: "e2b" });
    await provider.suspend!({ id: "sb-gone", backend: "e2b" });
    expect(paused).toEqual(["sb-1"]);
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
