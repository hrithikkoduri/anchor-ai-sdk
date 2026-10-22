import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HeyoGuestExecutor,
  buildJobLaunch,
} from "../../src/sandbox/heyo/exec.js";
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

  it("kills an expired job whose receipt never arrived and clears the slot", async () => {
    let clock = 0,
      launches = 0,
      kills = 0;
    const executor = new HeyoGuestExecutor(
      async (command) => {
        if (isLaunch(command)) {
          launches++;
          return reply("");
        }
        if (command.includes("pkill -f")) {
          kills++;
          return reply("killed");
        }
        return launches === 1 ? reply("RUNNING") : done();
      },
      async (ms) => {
        clock += ms;
      },
      () => clock,
    );
    const first = await executor.run("stuck mutation", 2);
    expect(first.failure).toMatchObject({
      kind: "transport",
      completion: "unknown",
    });
    expect(first.output).toContain("killed and the exec slot cleared");
    expect(kills).toBe(1);

    // The lost receipt must not wedge the sandbox: the next command runs.
    const second = await executor.run("next mutation", 2);
    expect(second.exitCode).toBe(0);
    expect(launches).toBe(2);
  });

  it("runs concurrent read-only jobs without refusing the second one", async () => {
    let launches = 0;
    const executor = new HeyoGuestExecutor(
      async (command) => {
        if (isLaunch(command)) {
          launches++;
          return reply("");
        }
        return done();
      },
      async () => undefined,
    );
    const [a, b] = await Promise.all([
      executor.run("read a", 120, undefined, { concurrent: true }),
      executor.run("read b", 120, undefined, { concurrent: true }),
    ]);
    expect([a.exitCode, b.exitCode]).toEqual([0, 0]);
    expect(launches).toBe(2);
  });

  it("detaches at backgroundAfterSecs and finishes later through poll", async () => {
    let clock = 0;
    let launches = 0;
    let finished = false;
    const executor = new HeyoGuestExecutor(
      async (command) => {
        if (isLaunch(command)) {
          launches++;
          return reply("");
        }
        if (command.startsWith("u=")) return reply("killed");
        return finished ? done() : reply("RUNNING");
      },
      async (ms) => {
        clock += ms;
      },
      () => clock,
    );
    const bg = await executor.run("long repro", 600, undefined, {
      backgroundAfterSecs: 5,
    });
    expect(launches).toBe(1);
    expect(bg.background?.jobId).toMatch(/anchor-exec-/);
    expect(bg.timedOut).toBe(false);
    expect(bg.exitCode).toBe(-1);
    expect(executor.hasJobs()).toBe(true);
    expect(await executor.poll(bg.background!.jobId)).toBeUndefined();
    finished = true;
    const result = await executor.poll(bg.background!.jobId, {
      startedAt: 0,
      timeoutSecs: 600,
    });
    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toBe("ok\n");
    expect(executor.hasJobs()).toBe(false);
  });

  it("does not let a detached job gate later mutations", async () => {
    let clock = 0;
    let launches = 0;
    let detached = false;
    const executor = new HeyoGuestExecutor(
      async (command) => {
        if (isLaunch(command)) {
          launches++;
          return reply("");
        }
        if (command.startsWith("u=")) return reply("killed");
        // Before the detach: the long job is still running. After it, any
        // observation belongs to a NEW command that has completed.
        return detached ? done() : reply("RUNNING");
      },
      async (ms) => {
        clock += ms;
      },
      () => clock,
    );
    const bg = await executor.run("long", 600, undefined, {
      backgroundAfterSecs: 1,
    });
    expect(bg.background).toBeDefined();
    detached = true;
    launches = 0;
    const next = await executor.run("mutate", 10);
    expect(launches).toBe(1);
    expect(next.exitCode).toBe(0);
  });

  it("kills a detached job and reports a missing receipt directory as gone", async () => {
    let clock = 0;
    let launches = 0;
    const executor = new HeyoGuestExecutor(
      async (command) => {
        if (isLaunch(command)) {
          launches++;
          return reply("");
        }
        if (command.startsWith("u=")) return reply("killed");
        if (command.includes("GONE")) return reply("GONE");
        return reply("RUNNING");
      },
      async (ms) => {
        clock += ms;
      },
      () => clock,
    );
    const bg = await executor.run("long", 600, undefined, {
      backgroundAfterSecs: 1,
    });
    const jobId = bg.background!.jobId;
    expect(await executor.kill(jobId)).toBe(true);
    expect(executor.hasJobs()).toBe(false);
    await expect(executor.poll(jobId)).rejects.toThrow(/gone/i);
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

  it("signal cancels a synchronously awaited job: kills the guest, resolves cancelled, clears the slot", async () => {
    let clock = 0,
      launches = 0,
      kills = 0,
      observations = 0;
    const controller = new AbortController();
    const executor = new HeyoGuestExecutor(
      async (command) => {
        if (isLaunch(command)) {
          launches++;
          return reply("");
        }
        if (command.includes("pkill")) {
          kills++;
          return reply("killed");
        }
        observations++;
        return reply("RUNNING");
      },
      async (ms) => {
        clock += ms;
        // Cancel the run after the first observation tick.
        if (clock >= 500) controller.abort();
      },
      () => clock,
    );
    const result = await executor.run("sleep 9999", 3600, undefined, {
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(launches).toBe(1);
    expect(kills).toBe(1);
    expect(observations).toBe(0); // cancelled before the first observation tick — not at the deadline
    // The slot is cleared: a later mutation is not gated by the dead job.
    expect(executor.hasJobs()).toBe(false);
  });

  it("signal does NOT kill a job that already detached (background contract)", async () => {
    let clock = 0,
      launches = 0,
      kills = 0;
    const controller = new AbortController();
    const executor = new HeyoGuestExecutor(
      async (command) => {
        if (isLaunch(command)) {
          launches++;
          return reply("");
        }
        if (command.includes("pkill")) {
          kills++;
          return reply("killed");
        }
        return reply("RUNNING");
      },
      async (ms) => {
        clock += ms;
        if (clock >= 1000) controller.abort();
      },
      () => clock,
    );
    const bg = await executor.run("long detached", 600, undefined, {
      backgroundAfterSecs: 1,
      signal: controller.signal,
    });
    // Detached first: the abort arrived AFTER backgroundAfterSecs, so the
    // job keeps its own lifetime — no kill, no cancelled flag.
    expect(bg.background).toBeDefined();
    expect(bg.cancelled).toBeUndefined();
    expect(kills).toBe(0);
    expect(executor.hasJobs()).toBe(true);
  });
});
