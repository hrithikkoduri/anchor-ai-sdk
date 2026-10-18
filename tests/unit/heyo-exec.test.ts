import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HeyoGuestExecutor,
  buildJobLaunch,
} from "../../src/sandbox/heyo-exec.js";
import { formatExec } from "../../src/tools/types.js";

const reply = (stdout: string, exit_code = 0) => ({
  stdout,
  stderr: "",
  output: stdout,
  exit_code,
});
const done = (code = 0, stdout = "ok\n", stderr = "") =>
  reply(
    `DONE:${code}\n${[stdout, stderr, stdout + stderr].map((text) => Buffer.from(text).toString("base64")).join("\n__ANCHOR_EXEC_STREAM__\n")}`,
  );
const isLaunch = (command: string) => command.includes("nohup bash");

describe("Heyo short-request execution", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("uses bounded FIFO collectors rather than Bash process substitutions that retain pipe writers on Linux", () => {
    const launch = buildJobLaunch("/tmp/owned-test-job", "echo test", 40);
    expect(launch).toContain("mkfifo");
    expect(launch).not.toContain(">(");
    expect(launch).toContain("timeout -k 5 50 bash -c");
    expect(launch).toContain("exit.tmp");
  });

  it("runs a long guest command through short observations, launching exactly once", async () => {
    let clock = 0,
      launches = 0,
      reads = 0;
    const executor = new HeyoGuestExecutor(
      async (command) => {
        if (isLaunch(command)) {
          launches++;
          return reply("");
        }
        return ++reads < 71 ? reply("RUNNING") : done();
      },
      async (ms) => {
        clock += ms;
      },
      () => clock,
    );
    const result = await executor.run("long command", 120);
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: "ok\n",
      durationMs: 35000,
    });
    expect(launches).toBe(1);
  });

  it("retries transient observation failures, never the command", async () => {
    let launches = 0,
      reads = 0;
    const executor = new HeyoGuestExecutor(
      async (command) => {
        if (isLaunch(command)) {
          launches++;
          return reply("");
        }
        if (++reads === 1) throw new Error("API 500");
        return done();
      },
      async () => undefined,
    );
    expect((await executor.run("mutating command", 120)).exitCode).toBe(0);
    expect(launches).toBe(1);
  });

  it("does not replay an ambiguous launch or start another command while it is pending", async () => {
    let launches = 0;
    const executor = new HeyoGuestExecutor(async (command) => {
      if (isLaunch(command)) {
        launches++;
        throw new Error("Command timed out after 30 seconds");
      }
      return reply("RUNNING");
    });
    const first = await executor.run("write a file", 120);
    expect(first).toMatchObject({
      exitCode: -1,
      timedOut: false,
      failure: { kind: "transport", completion: "unknown" },
    });
    const second = await executor.run("write a file again", 120);
    expect(second.output).toContain("No new command was launched");
    expect(launches).toBe(1);
    expect(formatExec(first, 120)).toContain("completion is unknown");
    expect(formatExec(first, 120)).not.toContain(
      "timed out after 120s (killed)",
    );
  });

  it("reports a confirmed guest deadline separately from transport failure", async () => {
    const executor = new HeyoGuestExecutor(async (command) =>
      isLaunch(command) ? reply("") : done(124),
    );
    const result = await executor.run("timeout-wrapped command", 2);
    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    expect(result.failure).toBeUndefined();
    expect(formatExec(result, 2)).toContain("2s deadline");
  });

  it("executes the actual spool wrapper locally and preserves stdout, stderr, exit status and env", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "anchor-job-test-"));
    const shell = promisify(execFile);
    const executor = new HeyoGuestExecutor(
      async (command, env) => {
        // This portable test exercises capture/receipts, not GNU timeout (which
        // macOS does not ship). Deadline semantics have separate adapter tests.
        const local = command
          .replaceAll("/tmp/anchor-exec-", `${directory}/job-`)
          .replace("timeout -k 5 12 bash -c", "bash -c");
        const result = await shell("bash", ["-c", local], {
          env: { ...process.env, ...env },
        });
        return {
          exit_code: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          output: result.stdout + result.stderr,
        };
      },
      async () => new Promise((resolve) => setTimeout(resolve, 10)),
    );
    const result = await executor.run(
      `bash -c 'printf "hello %s\\n" "$TEST_VALUE"; printf "problem\\n" >&2; exit 7'`,
      2,
      { TEST_VALUE: "world" },
    );
    expect(result).toMatchObject({
      exitCode: 7,
      stdout: "hello world\n",
      stderr: "problem\n",
      timedOut: false,
    });
    expect(result.output).toContain("hello world");
    expect(result.output).toContain("problem");
  });
});
