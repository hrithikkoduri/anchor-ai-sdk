/**
 * Daytona adapter without the network. `clientFactory` replaces the SDK, so
 * start/exec/adopt/fork/destroy are assertable offline; the live conformance
 * suite (`tests/integration/daytona-sandbox.test.ts`) covers the same paths
 * against the real control plane.
 */
import { describe, expect, it } from "vitest";
import {
  DaytonaSandbox,
  daytona,
  type DaytonaClient,
  type DaytonaSandboxHandle,
} from "../../src/sandbox/daytona/index.js";
import {
  daytonaCommand,
  daytonaResult,
  daytonaTransportFailure,
} from "../../src/sandbox/daytona/exec.js";

type Result = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  output?: string;
};

function fakeHandle(
  opts: {
    id?: string;
    state?: string;
    run?: (command: string) => Result;
    fail?: (command: string) => Error | undefined;
  } = {},
) {
  const calls: string[] = [];
  const record = {
    stopped: 0,
    deleted: 0,
    started: 0,
    forked: 0,
    network: [] as Array<Record<string, unknown>>,
  };
  const handle: DaytonaSandboxHandle = {
    id: opts.id ?? "sb-fake",
    ...(opts.state ? { state: opts.state } : {}),
    process: {
      createSession: async (sessionId: string) => {
        calls.push(`session:${sessionId}`);
      },
      executeSessionCommand: async (_sessionId, req) => {
        calls.push(req.command);
        const failure = opts.fail?.(req.command);
        if (failure) throw failure;
        const result = opts.run?.(req.command) ?? {};
        return {
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          ...(result.output !== undefined ? { output: result.output } : {}),
        };
      },
    },
    start: async () => {
      record.started++;
    },
    stop: async () => {
      record.stopped++;
    },
    delete: async () => {
      record.deleted++;
    },
    fork: async () => {
      record.forked++;
      return fakeHandle({ id: "sb-child" }).handle;
    },
    getPreviewLink: async (port: number) => ({
      url: `https://3000-${port}.daytona.test`,
      token: "tok-123",
    }),
    updateNetworkSettings: async (settings) => {
      record.network.push(settings);
    },
  };
  return { handle, calls, record };
}

function client(handle: DaytonaSandboxHandle, created: { params: unknown[] } = { params: [] }): DaytonaClient {
  return {
    create: async (params) => {
      created.params.push(params);
      return handle;
    },
    get: async () => handle,
    list: async function* () {
      yield {};
    },
  };
}

describe("daytona exec plumbing", () => {
  it("wraps a command with its cwd, env, and a guest-side kill deadline", () => {
    expect(daytonaCommand(`echo "it's fine"`, "/home/user/repo", 30)).toBe(
      `cd '/home/user/repo' && timeout -k 5 30 bash -c 'echo "it'\\''s fine"'`,
    );
  });

  it("passes env through the env binary, one quoted assignment each", () => {
    expect(
      daytonaCommand("env | grep GIT_TOKEN", "/w", 5, { GIT_TOKEN: "a b" }),
    ).toBe(
      `cd '/w' && env 'GIT_TOKEN=a b' timeout -k 5 5 bash -c 'env | grep GIT_TOKEN'`,
    );
  });

  it("starts with no env prefix when there is nothing to pass", () => {
    expect(daytonaCommand("pwd", "/w", 5, {})).toBe(
      `cd '/w' && timeout -k 5 5 bash -c 'pwd'`,
    );
  });

  it("maps a normal exit without inventing a timeout", () => {
    const result = daytonaResult(
      { exitCode: 0, stdout: "ok\n", stderr: "" },
      Date.now(),
    );
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      output: "ok\n",
      timedOut: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("treats timeout kill codes as timedOut", () => {
    for (const exitCode of [124, 137]) {
      expect(
        daytonaResult({ exitCode, stdout: "", stderr: "" }, Date.now()).timedOut,
      ).toBe(true);
    }
  });

  it("marks a transport failure as unknown completion, not a failed command", () => {
    const result = daytonaTransportFailure("connection reset", Date.now());
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
    expect(result.failure).toEqual({
      kind: "transport",
      completion: "unknown",
      message: "connection reset",
    });
  });
});

describe("daytona lifecycle (fake client)", () => {
  it("starts a fresh sandbox from a repoUrl, checks out the ref, and creates the exec session once", async () => {
    const fake = fakeHandle();
    const created = { params: [] as unknown[] };
    const sandbox = new DaytonaSandbox(
      { repoUrl: "https://example.test/acme/app.git", ref: "main" },
      { quiet: true, clientFactory: () => client(fake.handle, created) },
    );
    await sandbox.start();

    // The workspace coordinates ride on the sandbox, so a later adopt from a
    // preview opened from a fresh process need not guess them.
    expect(created.params[0]).toMatchObject({
      labels: { anchorWorkspace: "/home/user/repo", anchorScratch: "/tmp/anchor" },
    });
    expect(fake.calls.some((c) => c.includes("clone") && c.includes("app.git"))).toBe(true);
    expect(fake.calls.some((c) => c.includes("checkout") && c.includes("'main'"))).toBe(true);
    expect(fake.calls.some((c) => c.includes("user.name"))).toBe(true);
    // Exactly one session, reused by every command afterwards.
    expect(fake.calls.filter((c) => c.startsWith("session:"))).toHaveLength(1);
    expect(fake.record.deleted).toBe(0);
  });

  it("initialises an empty workspace when the spec names no repo", async () => {
    // `workspacePath` on a `.git`-less directory is an error by design; the
    // init path belongs to a spec with neither repoUrl nor workspacePath.
    const fake = fakeHandle({
      run: (command) => (command.includes("/.git") ? { exitCode: 1 } : {}),
    });
    const sandbox = new DaytonaSandbox(
      {},
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await sandbox.start();

    expect(fake.calls.some((c) => c.includes("mkdir -p"))).toBe(true);
    expect(fake.calls.some((c) => c.includes("git init -q -b main"))).toBe(true);
  });

  it("executes through the session with separate stdout/stderr and a deadline", async () => {
    const fake = fakeHandle({
      // Only the command under test fails; start()'s own probes must succeed.
      run: (command) =>
        command.includes("echo out")
          ? { exitCode: 7, stdout: "out", stderr: "err" }
          : {},
    });
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed" },
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await sandbox.start();
    const result = await sandbox.exec("echo out && echo err >&2 && exit 7", {
      cwd: "/testbed/src",
      env: { EXTRA: "1" },
      timeoutSecs: 30,
    });

    expect(result).toMatchObject({
      exitCode: 7,
      stdout: "out",
      stderr: "err",
      output: "outerr",
      timedOut: false,
    });
    const last = fake.calls.at(-1)!;
    expect(last).toContain("cd '/testbed/src'");
    expect(last).toContain("'EXTRA=1'");
    expect(last).toContain("timeout -k 5 30 bash -c");
  });

  it("reports a toolbox throw as a transport failure instead of replaying", async () => {
    const fake = fakeHandle({
      fail: (command) =>
        command.includes("git commit") ? new Error("socket hang up") : undefined,
    });
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed" },
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await sandbox.start();
    const before = fake.calls.filter((c) => c.includes("git commit")).length;

    const result = await sandbox.exec("git commit -am x");

    expect(result.failure).toEqual({
      kind: "transport",
      completion: "unknown",
      message: "socket hang up",
    });
    // The launch was observed once, never retried.
    expect(
      fake.calls.filter((c) => c.includes("git commit")).length - before,
    ).toBe(1);
  });

  it("mints one git token for many commands and never puts it in the workspace", async () => {
    let minted = 0;
    const fake = fakeHandle();
    const sandbox = new DaytonaSandbox(
      {
        workspacePath: "/testbed",
        git: {
          token: async () => {
            minted++;
            return "ghs_secret";
          },
        },
      },
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await sandbox.start();
    await sandbox.exec("echo one");
    await sandbox.exec("echo two");

    expect(minted).toBe(1);
    // It travels per command as env, and the helper reads $GIT_TOKEN — the
    // value is never written into git's config or the workspace.
    expect(fake.calls.at(-1)).toContain("'GIT_TOKEN=ghs_secret'");
    expect(fake.calls.some((c) => c.includes("password=ghs_secret"))).toBe(false);
    expect(
      fake.calls.some(
        (c) => c.includes("credential.helper") && c.includes("$GIT_TOKEN"),
      ),
    ).toBe(true);
  });

  it("wakes a stopped sandbox on adopt and reads the workspace from its disk", async () => {
    const fake = fakeHandle({ id: "sb-adopted", state: "stopped" });
    const sandbox = new DaytonaSandbox(
      { adopt: "sb-adopted", workspacePath: "/srv/repo" },
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await sandbox.start();

    expect(fake.record.started).toBe(1);
    expect(sandbox.id).toBe("sb-adopted");
    // The workspace comes from the retained disk, and it is proven to exist.
    expect(fake.calls[0]).toContain("test -d");
    expect(fake.calls[0]).toContain("/srv/repo");
  });

  it("fails an adopt loudly when the retained workspace is gone", async () => {
    const fake = fakeHandle({
      id: "sb-adopted",
      run: (command) => (command.includes("/.git") ? { exitCode: 1 } : {}),
    });
    const sandbox = new DaytonaSandbox(
      { adopt: "sb-adopted", workspacePath: "/srv/repo" },
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await expect(sandbox.start()).rejects.toThrow(/no workspace at \/srv\/repo/);
    // An adopted sandbox is not ours to delete.
    expect(fake.record.deleted).toBe(0);
  });

  it("stops a retained sandbox instead of deleting it, and is idempotent", async () => {
    const fake = fakeHandle();
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed", retain: true },
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await sandbox.start();
    await sandbox.destroy();
    await sandbox.destroy();

    expect(fake.record.stopped).toBe(1);
    expect(fake.record.deleted).toBe(0);
  });

  it("deletes a non-retained sandbox once", async () => {
    const fake = fakeHandle();
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed" },
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await sandbox.start();
    await sandbox.destroy();
    expect(fake.record.deleted).toBe(1);
  });

  it("deletes the sandbox it created when start fails", async () => {
    const fake = fakeHandle({
      run: (command) => (command.includes("/.git") ? { exitCode: 1 } : {}),
    });
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed" },
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await expect(sandbox.start()).rejects.toThrow(/not a git repository/);
    expect(fake.record.deleted).toBe(1);
  });

  it("blocks egress after setup when the spec asks for none", async () => {
    const fake = fakeHandle();
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed", egress: "none" },
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await sandbox.start();
    expect(fake.record.network).toEqual([{ networkBlockAll: true }]);
  });

  it("leaves egress alone for a full-network sandbox", async () => {
    const fake = fakeHandle();
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed" },
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await sandbox.start();
    expect(fake.record.network).toEqual([]);
  });

  it("exposes a guest port with Daytona's preview token", async () => {
    const fake = fakeHandle();
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed" },
      { quiet: true, clientFactory: () => client(fake.handle) },
    );
    await sandbox.start();

    await expect(sandbox.exposePort(3000)).resolves.toEqual({
      url: "https://3000-3000.daytona.test?daytona-preview-token=tok-123",
      port: 3000,
    });
    for (const port of [0, 65_536, 1.5, -1]) {
      await expect(sandbox.exposePort(port)).rejects.toThrow(/1\.\.65535/);
    }
  });
});

describe("daytona provider", () => {
  it("declares only the capabilities it implements", () => {
    const provider = daytona({ quiet: true });
    expect(provider.name).toBe("daytona");
    expect(provider.capabilities).toMatchObject({
      fork: true,
      retain: true,
      remoteCheckpoint: true,
      egressControl: true,
      localPath: false,
      previewPort: true,
      processStream: false,
    });
    // No background-job seam is claimed, so nothing can poll a job that will
    // never arrive.
    expect(provider.capabilities.publishImage).toBeUndefined();
  });

  it("is constructible with no credentials (startup must not throw)", () => {
    expect(() => daytona()).not.toThrow();
  });

  it("releases by handle, treating an already-gone sandbox as success", async () => {
    const deleted: string[] = [];
    const provider = daytona({
      quiet: true,
      clientFactory: () => ({
        create: async () => {
          throw new Error("unused");
        },
        get: async (id: string) => ({
          ...fakeHandle({ id }).handle,
          delete: async () => {
            deleted.push(id);
          },
        }),
      }),
    });
    await provider.release({ id: "sb-gone", backend: "daytona" });
    expect(deleted).toEqual(["sb-gone"]);

    const notFound = daytona({
      quiet: true,
      clientFactory: () => ({
        create: async () => {
          throw new Error("unused");
        },
        get: async () => {
          throw Object.assign(new Error("sandbox not found"), {
            statusCode: 404,
          });
        },
      }),
    });
    await expect(
      notFound.release({ id: "sb-missing", backend: "daytona" }),
    ).resolves.toBeUndefined();
  });

  it("probes with one authenticated list call", async () => {
    expect(
      await daytona({ quiet: true, clientFactory: () => client(fakeHandle().handle) }).probe(),
    ).toMatchObject({ ok: true, name: "daytona" });

    expect(
      await daytona({
        quiet: true,
        clientFactory: () => ({
          create: async () => {
            throw new Error("unused");
          },
          get: async () => {
            throw new Error("unused");
          },
          list: async function* () {
            throw new Error("401 unauthorized");
            yield {};
          },
        }),
      }).probe(),
    ).toMatchObject({ ok: false, detail: "401 unauthorized" });
  });
});
