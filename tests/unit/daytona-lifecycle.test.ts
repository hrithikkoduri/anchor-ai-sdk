/**
 * Daytona lifecycle without the network. The adapter's create/get calls are
 * injectable (`clientFactory`), so start/adopt/destroy can be asserted offline;
 * the live conformance suite covers the same paths for real.
 */
import { describe, expect, it } from "vitest";
import {
  DaytonaSandbox,
  daytona,
  type DaytonaClientFactory,
  type DaytonaSandboxClient,
} from "../../src/sandbox/daytona/index.js";

interface RunRecord {
  command: string;
  timeout?: number;
}

interface FakeState {
  created: Record<string, unknown>[];
  sessions: string[];
  deletedSessions: string[];
  commands: RunRecord[];
  started: number;
  stopped: number;
  deleted: number;
  home: string;
  /** Overrides the result for a command (substring match). */
  respond?: (command: string) => { exitCode?: number; stdout?: string; stderr?: string } | undefined;
}

function fakeClient(state: FakeState, id = "sb-fake"): DaytonaSandboxClient {
  const client = {
    id,
    state: "started",
    start: async () => {
      state.started += 1;
    },
    stop: async () => {
      state.stopped += 1;
      client.state = "stopped";
    },
    delete: async () => {
      state.deleted += 1;
      client.state = "destroyed";
    },
    getUserHomeDir: async () => state.home,
    process: {
      createSession: async (sessionId: string) => {
        state.sessions.push(sessionId);
      },
      executeSessionCommand: async (
        _sessionId: string,
        req: { command: string },
        timeout?: number,
      ) => {
        state.commands.push({ command: req.command, timeout });
        // A FRESH workspace has no .git yet: the adapter's `test -d` probe
        // must come back non-zero so it initializes one. Tests override this.
        const fallbackExit = /test -d /.test(req.command) ? 1 : 0;
        const override = state.respond?.(req.command);
        return {
          stdout: override?.stdout ?? "",
          stderr: override?.stderr ?? "",
          exitCode: override?.exitCode ?? fallbackExit,
        };
      },
      deleteSession: async (sessionId: string) => {
        state.deletedSessions.push(sessionId);
      },
    },
  };
  return client as unknown as DaytonaSandboxClient;
}

/** Undo the nested shell quoting so assertions can name plain substrings. */
function plain(commands: RunRecord[]): string {
  return commands
    .map((c) => c.command)
    .join("\n")
    .replace(/'\\''/g, "'")
    .replace(/'/g, "");
}

function newState(home = "/home/daytona"): FakeState {
  return {
    created: [],
    sessions: [],
    deletedSessions: [],
    commands: [],
    started: 0,
    stopped: 0,
    deleted: 0,
    home,
  };
}

function factoryFor(
  state: FakeState,
  options: { existing?: boolean } = {},
): DaytonaClientFactory {
  const client = fakeClient(state);
  return {
    create: async (params) => {
      state.created.push(params);
      return client;
    },
    get: async (idOrName) => {
      if (options.existing === false) {
        const { DaytonaNotFoundError } = await import("@daytonaio/sdk");
        throw new DaytonaNotFoundError(`Sandbox ${idOrName} not found`);
      }
      return { ...client, id: idOrName } as DaytonaSandboxClient;
    },
  };
}

describe("daytona lifecycle (fake client)", () => {
  it("starts a fresh sandbox, resolves the workspace from the sandbox home", async () => {
    const state = newState("/home/daytona");
    const sb = new DaytonaSandbox(
      {},
      { clientFactory: factoryFor(state), quiet: true },
    );
    await sb.start();

    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({ autoStopInterval: 0 });
    expect(sb.workspace).toBe("/home/daytona/repo");
    // The git identity + reserved scratch prep ran in the workspace.
    const joined = plain(state.commands);
    expect(joined).toContain("git init -q -b main /home/daytona/repo");
    expect(joined).toContain("git config user.name anchor");
    expect(joined).toContain("mkdir -p .anchor");
    // Every session it opened was cleaned up.
    expect(state.deletedSessions.sort()).toEqual([...state.sessions].sort());
  });

  it("uses a bare image sandbox's root home instead of hard-coding one", async () => {
    const state = newState("/root");
    const sb = new DaytonaSandbox(
      {},
      { clientFactory: factoryFor(state), quiet: true },
    );
    await sb.start();
    expect(sb.workspace).toBe("/root/repo");
  });

  it("passes spec.image as a Daytona image and rejects it twice", async () => {
    const state = newState();
    const sb = new DaytonaSandbox(
      { image: "ubuntu:24.04" },
      { clientFactory: factoryFor(state), quiet: true },
    );
    await sb.start();
    expect(state.created[0]).toMatchObject({ image: "ubuntu:24.04" });
    expect(state.created[0]!.snapshot).toBeUndefined();
  });

  it("falls back to the provider snapshot when the spec names no image", async () => {
    const state = newState();
    const sb = new DaytonaSandbox(
      {},
      {
        clientFactory: factoryFor(state),
        snapshot: "anchor-conformance",
        quiet: true,
      },
    );
    await sb.start();
    expect(state.created[0]).toMatchObject({ snapshot: "anchor-conformance" });
    expect(state.created[0]!.image).toBeUndefined();
  });

  it("honors workspacePath — verifies the checkout instead of cloning", async () => {
    const state = newState();
    state.respond = (command) => (/test -d /.test(command) ? { exitCode: 0 } : undefined);
    const sb = new DaytonaSandbox(
      { workspacePath: "/testbed" },
      { clientFactory: factoryFor(state), quiet: true },
    );
    await sb.start();
    expect(sb.workspace).toBe("/testbed");
    const joined = plain(state.commands);
    expect(joined).toContain("test -d /testbed");
    expect(joined).toContain("test -d /testbed/.git");
    expect(joined).not.toContain("git init");
    expect(joined).not.toContain("git clone");
  });

  it("fails start() loudly when workspacePath is not a git repository", async () => {
    const state = newState();
    // The directory exists; it is simply not a git repository.
    state.respond = (command) => ({ exitCode: command.includes("/.git") ? 1 : 0 });
    const sb = new DaytonaSandbox(
      { workspacePath: "/testbed" },
      { clientFactory: factoryFor(state), quiet: true },
    );
    await expect(sb.start()).rejects.toThrow(/not a git repository/);
    // A failed start must not leak the sandbox it created.
    expect(state.deleted).toBe(1);
  });

  it("rejects localPath and egress:none loudly instead of silently ignoring them", async () => {
    const state = newState();
    const byPath = new DaytonaSandbox(
      { localPath: "/tmp/repo" },
      { clientFactory: factoryFor(state), quiet: true },
    );
    await expect(byPath.start()).rejects.toThrow(/no host-path access/);

    const byEgress = new DaytonaSandbox(
      { egress: "none" },
      { clientFactory: factoryFor(state), quiet: true },
    );
    await expect(byEgress.start()).rejects.toThrow(/egress/);
    expect(state.created).toHaveLength(0);
  });

  it("adopts a retained sandbox by id and proves the workspace is there", async () => {
    const state = newState();
    state.respond = (command) => (/test -d /.test(command) ? { exitCode: 0 } : undefined);
    const sb = new DaytonaSandbox(
      { adopt: "sb-retained" },
      { clientFactory: factoryFor(state), quiet: true },
    );
    await sb.start();
    expect(sb.id).toBe("sb-retained");
    expect(state.started).toBe(1); // adopt wakes it
    expect(state.created).toHaveLength(0); // it does not create a new one
    expect(plain(state.commands)).toContain(
      "test -d /home/daytona/repo/.git",
    );
  });

  it("reports a gone retained sandbox as gone, not as a crash", async () => {
    const state = newState();
    const sb = new DaytonaSandbox(
      { adopt: "sb-ghost" },
      { clientFactory: factoryFor(state, { existing: false }), quiet: true },
    );
    await expect(sb.start()).rejects.toThrow(/is gone/);
    // An adopted sandbox is not ours to delete.
    expect(state.deleted).toBe(0);
  });

  it("stops a retained sandbox on destroy and keeps the debugging keep switch", async () => {
    const retired = newState();
    const retained = new DaytonaSandbox(
      { retain: true },
      { clientFactory: factoryFor(retired), quiet: true },
    );
    await retained.start();
    await retained.destroy();
    expect(retired.stopped).toBe(1);
    expect(retired.deleted).toBe(0);

    const kept = newState();
    const debuggable = new DaytonaSandbox(
      { keep: true },
      { clientFactory: factoryFor(kept), quiet: true },
    );
    await debuggable.start();
    await debuggable.destroy();
    expect(kept.stopped).toBe(0);
    expect(kept.deleted).toBe(0);
  });

  it("deletes a non-retained sandbox, and destroy is idempotent", async () => {
    const state = newState();
    const sb = new DaytonaSandbox(
      {},
      { clientFactory: factoryFor(state), quiet: true },
    );
    await sb.start();
    await sb.destroy();
    await sb.destroy();
    expect(state.deleted).toBe(1);
    await expect(sb.exec("pwd")).rejects.toThrow(/was destroyed/);
  });

  it("reports exec stdout, stderr, exit code, and a real timeout", async () => {
    const state = newState();
    state.respond = (command) => {
      if (command.includes("sleep 30")) return { exitCode: 124 };
      if (command.includes("fail")) return { exitCode: 7, stdout: "out\n", stderr: "err\n" };
      return undefined;
    };
    const sb = new DaytonaSandbox(
      {},
      { clientFactory: factoryFor(state), quiet: true },
    );
    await sb.start();

    const failed = await sb.exec("fail");
    expect(failed).toMatchObject({ exitCode: 7, stdout: "out\n", stderr: "err\n" });

    const killed = await sb.exec("sleep 30", { timeoutSecs: 1 });
    expect(killed.timedOut).toBe(true);
    expect(killed.exitCode).toBe(124);
    // The guest-side deadline is what runs, with a longer transport guard.
    const record = state.commands.find((c) => c.command.includes("sleep 30"))!;
    expect(record.command).toContain("timeout -k 5 1");
    expect(record.timeout).toBe(31);
  });

  it("starts one short-lived session per call — no state is shared", async () => {
    const state = newState();
    const sb = new DaytonaSandbox(
      {},
      { clientFactory: factoryFor(state), quiet: true },
    );
    await sb.start();
    const before = state.sessions.length;
    await Promise.all([sb.exec("cat a"), sb.exec("cat b")]);
    const used = state.sessions.slice(before);
    expect(used).toHaveLength(2);
    expect(new Set(used).size).toBe(2);
    expect(state.deletedSessions).toContain(used[0]);
    expect(state.deletedSessions).toContain(used[1]);
  });

  it("declares capabilities it can actually honor", async () => {
    const state = newState();
    const provider = daytona({ clientFactory: factoryFor(state), quiet: true });
    expect(provider.name).toBe("daytona");
    expect(provider.capabilities).toMatchObject({
      fork: false,
      retain: true,
      remoteCheckpoint: true,
      egressControl: false,
      localPath: false,
      processStream: false,
    });
    // No publisher is claimed, so none is exposed.
    expect(provider.capabilities.publishImage).toBeFalsy();
    expect(provider.imagePublisher).toBeUndefined();

    const sb = provider.create({});
    expect(sb.openProcess).toBeUndefined();
    expect("pollJob" in sb).toBe(false);
  });

  it("refuses fork() with the API's own reason instead of throwing something vague", async () => {
    const state = newState();
    const sb = new DaytonaSandbox(
      {},
      { clientFactory: factoryFor(state), quiet: true },
    );
    await sb.start();
    await expect(sb.fork()).rejects.toThrow(/Forking is not supported/);
  });

  it("mints a git token once and passes it as env, never into the workspace", async () => {
    const state = newState();
    let mints = 0;
    state.respond = (command) => {
      if (command.includes("rev-parse HEAD")) return { stdout: "a".repeat(40) + "\n" };
      return undefined;
    };
    const sb = new DaytonaSandbox(
      {
        git: {
          token: async () => {
            mints += 1;
            return "ghs_secret";
          },
        },
      },
      { clientFactory: factoryFor(state), quiet: true },
    );
    await sb.start();
    await sb.checkpoint("cp");
    expect(mints).toBe(1); // cached, not re-minted per command
    expect(state.commands.some((c) => c.command.includes("env 'GIT_TOKEN=ghs_secret'"))).toBe(true);
    // The token is an env value on every command, never an argv value: strip
    // the `env 'GIT_TOKEN=...'` assignment and no other occurrence remains.
    for (const { command } of state.commands) {
      const withoutEnv = command.replace(/env 'GIT_TOKEN=[^']*'/g, "");
      expect(withoutEnv).not.toContain("ghs_secret");
    }
  });

  it("reports a transport failure as unknown completion", async () => {
    const state = newState();
    const client = fakeClient(state);
    const realRun = client.process.executeSessionCommand.bind(client.process);
    let started = false;
    client.process.executeSessionCommand = async (sessionId, req, timeout) => {
      if (!started) return realRun(sessionId, req, timeout);
      throw new Error("socket hang up");
    };
    const sb = new DaytonaSandbox(
      {},
      {
        clientFactory: { create: async () => client, get: async () => client },
        quiet: true,
      },
    );
    await sb.start();
    started = true;
    const result = await sb.exec("pwd");
    expect(result.exitCode).toBe(-1);
    expect(result.failure).toMatchObject({
      kind: "transport",
      completion: "unknown",
      message: "socket hang up",
    });
    // The session the failed call opened is still cleaned up.
    expect(state.deletedSessions.length).toBe(state.sessions.length);
  });
});
