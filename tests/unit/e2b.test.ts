import { describe, expect, it } from "vitest";
import { e2b } from "../../src/sandbox/e2b/index.js";
import {
  e2bCommand,
  e2bResult,
  e2bTransportFailure,
} from "../../src/sandbox/e2b/exec.js";

describe("e2b exec plumbing", () => {
  it("wraps a command in a workspace cd and a guest-side kill deadline", () => {
    const command = e2bCommand(`echo "it's fine" && pwd`, "/home/user/repo", 30);
    expect(command).toBe(
      `cd '/home/user/repo' && timeout -k 5 30 bash -c 'echo "it'\\''s fine" && pwd'`,
    );
  });

  it("maps a normal exit without inventing a timeout", () => {
    const result = e2bResult(
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

  it("reports a real non-zero exit as a failed command", () => {
    const result = e2bResult(
      { exitCode: 7, stdout: "out", stderr: "err" },
      Date.now(),
    );
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.output).toBe("outerr");
  });

  it("treats timeout kill codes as timedOut", () => {
    for (const exitCode of [124, 137]) {
      expect(
        e2bResult({ exitCode, stdout: "", stderr: "" }, Date.now()).timedOut,
      ).toBe(true);
    }
  });

  it("treats an E2B timeout error as timedOut even without a kill code", () => {
    const result = e2bResult(
      { exitCode: -1, error: "command timed out after 1s" },
      Date.now(),
    );
    expect(result.timedOut).toBe(true);
  });

  it("keeps arrival-order output when the caller collected it", () => {
    const result = e2bResult(
      { exitCode: 0, stdout: "buffered-out", stderr: "buffered-err" },
      Date.now(),
      { output: "out-err-in-arrival-order" },
    );
    expect(result.output).toBe("out-err-in-arrival-order");
    expect(result.stdout).toBe("buffered-out");
    expect(result.stderr).toBe("buffered-err");
  });

  it("marks a transport failure as unknown completion, not a failed command", () => {
    const result = e2bTransportFailure("connection reset", Date.now());
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
    expect(result.failure).toEqual({
      kind: "transport",
      completion: "unknown",
      message: "connection reset",
    });
  });
});

describe("e2b provider", () => {
  it("declares only the capabilities the adapter implements", () => {
    const provider = e2b({ template: "anchor-test", quiet: true });
    expect(provider.name).toBe("e2b");
    expect(provider.capabilities).toEqual({
      fork: true,
      retain: true,
      remoteCheckpoint: true,
      egressControl: false,
      localPath: false,
      processStream: true,
      publishImage: true,
      previewPort: true,
    });
  });

  it("constructs a sandbox without doing network I/O", () => {
    const sandbox = e2b({ quiet: true }).create({
      workspacePath: "/testbed",
    });
    expect(sandbox.backend).toBe("e2b");
    expect(sandbox.workspace).toBe("/testbed");
    expect(sandbox.scratch).toBe("/tmp/anchor");
    expect(sandbox.id).toBe("pending");
  });

  it("destroy() before start is a no-op", async () => {
    const sandbox = e2b({ quiet: true }).create({});
    await expect(sandbox.destroy()).resolves.toBeUndefined();
    await expect(sandbox.destroy()).resolves.toBeUndefined();
  });
});
