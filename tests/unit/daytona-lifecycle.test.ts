/**
 * Daytona lifecycle without the network. The adapter's create/get calls are
 * injectable (`clientFactory`), so start/adopt/destroy/fork can be asserted
 * offline; the live conformance suite covers the same paths for real.
 */
import { describe, expect, it } from "vitest";
import type { Sandbox as DaytonaSandboxClient } from "@daytona/sdk";
import {
  DaytonaSandbox,
  type DaytonaClientFactory,
} from "../../src/sandbox/daytona/index.js";

type ExecArgs = [command: string, cwd?: string, env?: Record<string, string>, timeout?: number];

function fakeClient(opts: {
  sandboxId?: string;
  labels?: Record<string, string>;
  run?: (command: string) => { exitCode?: number; result?: string };
} = {}) {
  const calls: string[] = [];
  const deleted: string[] = [];
  const paused: string[] = [];
  const started: string[] = [];
  const client = {
    id: opts.sandboxId ?? "sb-fake",
    labels: opts.labels ?? {},
    process: {
      executeCommand: async (...[command, , env, timeout]: ExecArgs) => {
        calls.push(command);
        void env;
        void timeout;
        const result = opts.run?.(command) ?? {};
        return {
          exitCode: result.exitCode ?? 0,
          result: result.result ?? "",
        };
      },
    },
    start: async () => {
      started.push("start");
    },
    pause: async () => {
      paused.push("pause");
    },
    delete: async () => {
      deleted.push("delete");
    },
    fork: async () => {
      throw new Error("fork not stubbed on this client");
    },
  };
  return { client: client as unknown as DaytonaSandboxClient, calls, deleted, paused, started };
}

function factory(
  client: DaytonaSandboxClient,
): DaytonaClientFactory {
  return {
    create: async () => client,
    get: async () => {
      await client.start();
      return client;
    },
  };
}

describe("daytona lifecycle (fake client)", () => {
  it("prepares a pre-provisioned workspace and starts", async () => {
    const fake = fakeClient();
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed", image: "debian:12" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();

    // Commands arrive wrapped: `cd … && timeout … bash -c '<command>'`.
    expect(fake.calls[0]).toContain("test -d");
    expect(fake.calls[0]).toContain("/testbed");
    expect(fake.calls[1]).toContain("/testbed/.git");
    expect(fake.calls.some((c) => c.includes("user.name"))).toBe(true);
    expect(fake.deleted).toHaveLength(0);
  });

  it("deletes the sandbox it created when start fails", async () => {
    const fake = fakeClient({
      run: (command) =>
        command.includes("/.git") ? { exitCode: 1 } : { exitCode: 0 },
    });
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed", image: "debian:12" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await expect(sandbox.start()).rejects.toThrow(/not a git repository/);
    expect(fake.deleted).toHaveLength(1);
  });

  it("never deletes an adopted sandbox when start fails", async () => {
    const fake = fakeClient({
      sandboxId: "sb-adopted",
      run: (command) =>
        command.includes("/.git") ? { exitCode: 1 } : { exitCode: 0 },
    });
    const sandbox = new DaytonaSandbox(
      { adopt: "sb-adopted" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await expect(sandbox.start()).rejects.toThrow(/no workspace/);
    expect(fake.deleted).toHaveLength(0);
  });

  it("starts an adopted (retained) sandbox on connect", async () => {
    const fake = fakeClient({ sandboxId: "sb-adopted" });
    const sandbox = new DaytonaSandbox(
      { adopt: "sb-adopted" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();
    expect(fake.started).toHaveLength(1);
  });

  it("restores workspace and scratch from the sandbox's labels on adopt", async () => {
    const fake = fakeClient({
      sandboxId: "sb-adopted",
      labels: {
        anchorWorkspace: Buffer.from("/srv/repo").toString("base64"),
        anchorScratch: Buffer.from("/srv/scratch").toString("base64"),
      },
    });
    const sandbox = new DaytonaSandbox(
      { adopt: "sb-adopted" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();
    expect(sandbox.workspace).toBe("/srv/repo");
    expect(sandbox.scratch).toBe("/srv/scratch");
    expect(fake.calls[0]).toContain("/srv/repo");
    expect(fake.calls[0]).toContain(".git");
  });

  it("fails loudly when no image is configured", async () => {
    const fake = fakeClient();
    const sandbox = new DaytonaSandbox(
      {},
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await expect(sandbox.start()).rejects.toThrow(/no image/);
  });

  it("pauses a retained sandbox instead of deleting it, and is idempotent", async () => {
    const fake = fakeClient();
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed", retain: true, image: "debian:12" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();
    await sandbox.destroy();
    await sandbox.destroy();
    expect(fake.paused).toHaveLength(1);
    expect(fake.deleted).toHaveLength(0);
  });

  it("keeps a sandbox when spec.keep is set", async () => {
    const fake = fakeClient();
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed", keep: true, image: "debian:12" },
      { quiet: true, clientFactory: factory(fake.client) },
    );
    await sandbox.start();
    await sandbox.destroy();
    expect(fake.paused).toHaveLength(0);
    expect(fake.deleted).toHaveLength(0);
  });

  it("mints one git token for many commands", async () => {
    let minted = 0;
    const fake = fakeClient();
    const sandbox = new DaytonaSandbox(
      {
        workspacePath: "/testbed",
        image: "debian:12",
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

  it("passes env vars through to executeCommand", async () => {
    const fake = fakeClient();
    const seen: { env?: Record<string, string>; cwd?: string; timeout?: number }[] = [];
    const recording = {
      ...fake.client,
      process: {
        executeCommand: async (
          command: string,
          cwd?: string,
          env?: Record<string, string>,
          timeout?: number,
        ) => {
          void command;
          seen.push({ env, cwd, timeout });
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as DaytonaSandboxClient;
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed", image: "debian:12", env: { A: "1" } },
      { quiet: true, clientFactory: factory(recording) },
    );
    await sandbox.start();
    await sandbox.exec("printenv", { env: { B: "2" }, timeoutSecs: 45 });
    const last = seen.at(-1);
    expect(last?.cwd).toBe("/");
    expect(last?.env).toMatchObject({ A: "1", B: "2" });
    // Transport guard: guest-side kill at 45s, HTTP deadline slightly later.
    expect(last?.timeout).toBe(75);
  });

  it("reports a thrown executeCommand as a transport failure", async () => {
    const failing = {
      ...fakeClient().client,
      process: {
        executeCommand: async (command: string) => {
          if (command.includes("echo hi")) {
            throw new Error("socket hang up");
          }
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as DaytonaSandboxClient;
    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed", image: "debian:12" },
      { quiet: true, clientFactory: factory(failing) },
    );
    await sandbox.start();
    const result = await sandbox.exec("echo hi");
    expect(result.exitCode).toBe(-1);
    expect(result.failure).toMatchObject({
      kind: "transport",
      completion: "unknown",
    });
  });

  it("forks and resets the child to the requested commit", async () => {
    const child = fakeClient({ sandboxId: "sb-child" });
    const parent = fakeClient();
    const parentClient = parent.client as unknown as {
      fork: () => Promise<unknown>;
    };
    parentClient.fork = async () => child.client;

    const sandbox = new DaytonaSandbox(
      { workspacePath: "/testbed", image: "debian:12" },
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
