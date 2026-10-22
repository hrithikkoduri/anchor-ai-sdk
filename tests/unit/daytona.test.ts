import { describe, expect, it } from "vitest";
import { daytona } from "../../src/sandbox/daytona/index.js";
import {
  daytonaCommand,
  daytonaResult,
  daytonaTransportFailure,
} from "../../src/sandbox/daytona/exec.js";

describe("daytona exec plumbing", () => {
  it("wraps a command in a workspace cd and a guest-side kill deadline", () => {
    const command = daytonaCommand(
      `echo "it's fine" && pwd`,
      "/workspace/repo",
      30,
    );
    expect(command).toBe(
      `cd '/workspace/repo' && timeout -k 5 30 bash -c 'echo "it'\\''s fine" && pwd'`,
    );
  });

  it("maps a normal exit without inventing a timeout", () => {
    const result = daytonaResult(
      { exitCode: 0, result: "ok\n" },
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

  it("reports a real non-zero exit as a failed command", () => {
    const result = daytonaResult(
      { exitCode: 7, result: "mixed out/err" },
      Date.now(),
    );
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.output).toBe("mixed out/err");
  });

  it("treats timeout kill codes as timedOut", () => {
    for (const exitCode of [124, 137]) {
      expect(
        daytonaResult({ exitCode, result: "" }, Date.now()).timedOut,
      ).toBe(true);
    }
  });

  it("maps a missing exit code to -1, not 0", () => {
    const result = daytonaResult({ result: "no code" }, Date.now());
    expect(result.exitCode).toBe(-1);
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

describe("daytona provider", () => {
  it("declares only the capabilities the adapter implements", () => {
    const provider = daytona({ image: "debian:12", quiet: true });
    expect(provider.name).toBe("daytona");
    expect(provider.capabilities).toEqual({
      fork: true,
      retain: true,
      remoteCheckpoint: true,
      egressControl: false,
      localPath: false,
      buildImage: true,
    });
  });

  it("constructs a sandbox without doing network I/O", () => {
    const sandbox = daytona({ quiet: true }).create({
      workspacePath: "/testbed",
    });
    expect(sandbox.backend).toBe("daytona");
    expect(sandbox.workspace).toBe("/testbed");
    expect(sandbox.scratch).toBe("/tmp/anchor");
    expect(sandbox.id).toBe("pending");
  });

  it("destroy() before start is a no-op", async () => {
    const sandbox = daytona({ quiet: true }).create({});
    await expect(sandbox.destroy()).resolves.toBeUndefined();
    await expect(sandbox.destroy()).resolves.toBeUndefined();
  });

  it("adopts by handle id, keeping the backend verbatim", () => {
    const provider = daytona({ quiet: true });
    const adopted = provider.adopt(
      { id: "sb-retained", backend: "daytona" },
      {},
    );
    expect(adopted.id).toBe("sb-retained");
    // A foreign handle is the caller's bookkeeping mistake; the sandbox
    // still reports its own backend.
    expect(adopted.backend).toBe("daytona");
  });
});
