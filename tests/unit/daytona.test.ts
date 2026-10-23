import { describe, expect, it } from "vitest";
import {
  daytonaCommand,
  daytonaResult,
  daytonaTransportFailure,
} from "../../src/sandbox/daytona/exec.js";

describe("daytona exec plumbing", () => {
  it("wraps a command in a workspace cd and a guest-side kill deadline", () => {
    const command = daytonaCommand(`echo "it's fine" && pwd`, "/home/daytona/repo", 30);
    expect(command).toBe(
      `cd '/home/daytona/repo' && timeout -k 5 30 bash -c 'echo "it'\\''s fine" && pwd'`,
    );
  });

  it("layers per-call env through env(1), not VAR= prefixes", () => {
    const command = daytonaCommand("echo $A", "/w", 5, {
      A: "one",
      B: "it's two",
    });
    expect(command).toBe(
      `cd '/w' && timeout -k 5 5 env 'A=one' 'B=it'\\''s two' bash -c 'echo $A'`,
    );
    // A value cannot escape into the command: it is one quoted argv element.
    expect(command).not.toContain("B=it's two'");
  });

  it("omits the env(1) layer when there is nothing to inject", () => {
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

  it("keeps stdout and stderr separate — session exec reports both", () => {
    const result = daytonaResult(
      { exitCode: 7, stdout: "out\n", stderr: "err\n" },
      Date.now(),
    );
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(result.output).toBe("out\nerr\n");
  });

  it("prefers Daytona's recorded stream order when it provides one", () => {
    const result = daytonaResult(
      { exitCode: 0, stdout: "o", stderr: "e", output: "e-then-o" },
      Date.now(),
    );
    expect(result.output).toBe("e-then-o");
  });

  it("treats timeout kill codes as timedOut", () => {
    for (const exitCode of [124, 137]) {
      expect(
        daytonaResult({ exitCode, stdout: "", stderr: "" }, Date.now()).timedOut,
      ).toBe(true);
    }
  });

  it("reports a missing exit code as -1 rather than a fake success", () => {
    const result = daytonaResult({ stdout: "half" }, Date.now());
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
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
