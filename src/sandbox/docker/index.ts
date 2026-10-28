/**
 * DockerSandbox — the `Sandbox` interface on local Docker containers.
 *
 * The home for benchmark-shaped work: `spec.image` + `spec.workspacePath` boot
 * a container whose workspace ALREADY exists with its full dependency
 * environment (a SWE-bench instance image: the repo checked out at a commit in
 * /testbed, tests installed). Generic use works too: pass `repoUrl` and the
 * repo is cloned inside the container, or nothing and the workspace starts
 * empty and git-initialized.
 *
 * Docker is driven through its CLI (spawn), so this file adds no npm
 * dependency; the CLI must resolve on PATH or `dockerBin` must name it.
 * Containers are `sb-anchor-*`; a retained container is STOPPED, not removed,
 * and the next run adopts it by name — the same continuity contract as every
 * backend. On arm64 hosts, amd64-only images run under emulation; that is the
 * host platform's business, not this adapter's.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  clampTimeout,
  newSandboxId,
  shq,
  SandboxGoneError,
  type Checkpoint,
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  type SandboxSpec,
  type ProcessHandle,
  type ProcessOptions,
} from "../types.js";
import { ChildProcessHandle } from "../process.js";
import { dockerImagePublisher } from "./image.js";
import {
  checkpointVia,
  hasChangesFromVia,
  reservedScratchPrepCommand,
  type GitAccess,
} from "../git.js";
import type { ProviderHealth, SandboxProvider } from "../provider.js";

export interface DockerSandboxOptions {
  /** Image for sandboxes whose spec names none (`spec.image` wins). */
  image?: string;
  /** Docker CLI (default `docker`, resolved through PATH). */
  dockerBin?: string;
  /** Silence lifecycle notes (tests). */
  quiet?: boolean;
}

const DEFAULT_WORKSPACE = "/workspace/repo";

export class DockerSandbox implements Sandbox {
  readonly backend = "docker" as const;
  readonly id: string;
  /** The repo directory inside the container. */
  readonly workspace: string;
  /** Scratch inside the container, outside the repo (spills, notes). */
  readonly scratch = "/tmp/anchor";

  private started = false;
  private destroyed = false;
  private readonly jobs = new Map<
    string,
    {
      child: ReturnType<typeof spawn>;
      startedAt: number;
      timeoutSecs: number;
      stdout: string;
      stderr: string;
      output: string;
      result?: ExecResult;
    }
  >();
  private readonly processes = new Map<string, ChildProcessHandle>();

  constructor(
    private readonly spec: SandboxSpec,
    private readonly opts: DockerSandboxOptions = {},
  ) {
    this.id = spec.adopt ?? newSandboxId();
    this.workspace = spec.workspacePath ?? DEFAULT_WORKSPACE;
  }

  private get dockerBin(): string {
    return this.opts.dockerBin ?? "docker";
  }

  async start(): Promise<void> {
    if (this.started) return;
    let createdContainer = false;

    if (this.spec.adopt) {
      const status = await this.cli([
        "inspect",
        "--format",
        "{{.State.Status}}",
        this.id,
      ]);
      if (status.exitCode !== 0) {
        throw new SandboxGoneError(
          `retained sandbox ${this.id} has no container`,
          this.id,
        );
      }
      if (status.stdout.trim() !== "running") {
        const up = await this.cli(["start", this.id], { timeoutSecs: 120 });
        if (up.exitCode !== 0) {
          throw new Error(
            `could not wake container ${this.id}: ${up.output.trim()}`,
          );
        }
      }
    } else {
      const image = this.spec.image ?? this.opts.image;
      if (!image) {
        throw new Error(
          "docker backend needs an image: set spec.image or docker({ image })",
        );
      }
      if ((await this.cli(["image", "inspect", image])).exitCode !== 0) {
        const pull = await this.cli(["pull", image], { timeoutSecs: 1800 });
        if (pull.exitCode !== 0) {
          throw new Error(
            `docker pull ${image} failed: ${pull.output.trim().slice(0, 500)}`,
          );
        }
      }
      const run = await this.cli(
        [
          "run",
          "-d",
          "--name",
          this.id,
          "--entrypoint",
          "sleep",
          image,
          "infinity",
        ],
        { timeoutSecs: 300 },
      );
      if (run.exitCode !== 0) {
        throw new Error(
          `docker run failed: ${run.output.trim().slice(0, 500)}`,
        );
      }
      createdContainer = true;
    }

    try {
      // The workspace must exist: a named path comes from the image; a repoUrl
      // is cloned; nothing means an empty, git-initialized directory.
      let gitWorkspace = true;
      if (this.spec.workspacePath) {
        const present = await this.execRaw(`test -d ${shq(this.workspace)}`, {
          cwd: "/",
          timeoutSecs: 60,
        });
        if (present.exitCode !== 0) {
          throw new Error(
            `workspacePath ${this.workspace} does not exist in ${this.spec.image ?? this.opts.image}`,
          );
        }
        // Harbor task images are not all git repos (Terminal-Bench). Git is a
        // capability of the workspace, not a precondition for running a shell.
        const hasGit = await this.execRaw(
          `test -d ${shq(`${this.workspace}/.git`)}`,
          { cwd: "/", timeoutSecs: 60 },
        );
        gitWorkspace = hasGit.exitCode === 0;
      } else if (this.spec.repoUrl) {
        const clone = await this.execRaw(
          `git clone --quiet ${shq(this.spec.repoUrl)} ${shq(this.workspace)}`,
          { cwd: "/", timeoutSecs: 900 },
        );
        if (clone.exitCode !== 0) {
          throw new Error(
            `git clone failed: ${clone.output.trim().slice(0, 500)}`,
          );
        }
        if (this.spec.ref) {
          const checkout = await this.execRaw(
            `git -C ${shq(this.workspace)} checkout --quiet ${shq(this.spec.ref)}`,
            { timeoutSecs: 120 },
          );
          if (checkout.exitCode !== 0) {
            throw new Error(
              `git checkout ${this.spec.ref} failed: ${checkout.output.trim()}`,
            );
          }
        }
      } else {
        await this.execRaw(`mkdir -p ${shq(this.workspace)}`, {
          cwd: "/",
          timeoutSecs: 60,
        });
        const hasGit = await this.execRaw(
          `test -d ${shq(`${this.workspace}/.git`)}`,
          { cwd: "/", timeoutSecs: 60 },
        );
        if (hasGit.exitCode !== 0) {
          const init = await this.execRaw(
            `git init -q -b main ${shq(this.workspace)}`,
            { cwd: "/", timeoutSecs: 120 },
          );
          if (init.exitCode !== 0) {
            throw new Error(`git init failed: ${init.output.trim()}`);
          }
        }
      }

      if (gitWorkspace) {
        const access = this.gitAccess();
        // Benchmark images ship exec bits that their git index does not
        // record; ignoring mode drift keeps patches (and hasChangesFrom)
        // about CONTENT — a fresh boot must never read as "new work".
        await access.git(["config", "core.fileMode", "false"]);
        await access.git([
          "config",
          "user.name",
          this.spec.gitIdentity?.name ?? "anchor",
        ]);
        await access.git([
          "config",
          "user.email",
          this.spec.gitIdentity?.email ?? "anchor@localhost",
        ]);
      }
      // The reserved .anchor dir: git-excluded (status/diff), checkpoint-carried.
      await this.execRaw(reservedScratchPrepCommand(), { timeoutSecs: 60 });

      // Setup is done; from here the agent runs without egress when asked.
      await this.applyEgress();

      this.started = true;
    } catch (error) {
      // A failed start must not leak the container it just created (adopted
      // containers are not ours to remove — only freshly created ones).
      if (createdContainer) {
        await this.cli(["rm", "-f", this.id], { timeoutSecs: 120 });
      }
      throw error;
    }
  }

  /**
   * Cut the container off after setup. `docker exec` keeps working; only the
   * network goes away. Every attached network is disconnected, so a custom
   * bridge does not silently survive; "already disconnected" (a retained
   * container) is not an error, anything else is — an isolation the caller
   * asked for and did not get must be loud.
   */
  private async applyEgress(): Promise<void> {
    if ((this.spec.egress ?? "full") !== "none") return;
    const listed = await this.cli([
      "inspect",
      "-f",
      "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}\n{{end}}",
      this.id,
    ]);
    if (listed.exitCode !== 0) {
      throw new Error(
        `docker egress: could not inspect ${this.id}: ${listed.output.trim()}`,
      );
    }
    for (const network of listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")) {
      const off = await this.cli(["network", "disconnect", network, this.id], {
        timeoutSecs: 60,
      });
      if (off.exitCode !== 0 && !/not connected|is not connected/i.test(off.output)) {
        throw new Error(
          `docker egress: could not disconnect ${this.id} from ${network}: ${off.output.trim()}`,
        );
      }
    }
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertUsable();
    if (opts.backgroundAfterSecs !== undefined && opts.backgroundAfterSecs > 0) {
      return this.execBackground(command, opts);
    }
    return this.execRaw(command, opts);
  }

  private execArgs(
    command: string,
    opts: ExecOptions,
  ): { args: string[]; timeoutSecs: number } {
    const timeoutSecs = clampTimeout(opts.timeoutSecs);
    const cwd = opts.cwd ?? this.workspace;
    const env = { ...this.spec.env, ...opts.env };
    const envFlags = Object.entries(env).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]);
    // Guest-side deadline (docker exec has none); the inner shell string is
    // ONE argv element, so quoting survives without a host shell.
    const inner = `cd ${shq(cwd)} && ${command}`;
    return {
      timeoutSecs,
      args: [
        "exec",
        ...envFlags,
        this.id,
        "timeout",
        "-k",
        "5",
        String(timeoutSecs),
        "bash",
        "-c",
        inner,
      ],
    };
  }

  /** Exec without the started guard — start()'s own setup uses this. */
  private execRaw(
    command: string,
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    const { args, timeoutSecs } = this.execArgs(command, opts);
    return this.cli(args, { timeoutSecs });
  }

  /**
   * Detached host-side docker-exec process. The guest command still has its
   * hard timeout; the caller gets a job handle after backgroundAfterSecs and
   * polls the same child later.
   */
  private execBackground(
    command: string,
    opts: ExecOptions,
  ): Promise<ExecResult> {
    const { args, timeoutSecs } = this.execArgs(command, opts);
    const jobId = randomUUID();
    const startedAt = Date.now();
    const thresholdMs = Math.max(0, (opts.backgroundAfterSecs ?? 0) * 1000);
    const child = spawn(this.dockerBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job: {
      child: ReturnType<typeof spawn>;
      startedAt: number;
      timeoutSecs: number;
      stdout: string;
      stderr: string;
      output: string;
      result?: ExecResult;
    } = {
      child,
      startedAt,
      timeoutSecs,
      stdout: "",
      stderr: "",
      output: "",
    };
    this.jobs.set(jobId, job);
    let timedOut = false;
    let settled = false;

    return new Promise((resolve) => {
      const threshold = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({
          exitCode: -1,
          stdout: job.stdout,
          stderr: job.stderr,
          output: job.output,
          timedOut: false,
          durationMs: Date.now() - startedAt,
          background: { jobId },
        });
      }, thresholdMs);
      const guard = setTimeout(
        () => {
          timedOut = true;
          child.kill("SIGKILL");
        },
        (timeoutSecs + 60) * 1000,
      );
      const finish = (exitCode: number): ExecResult => {
        const result: ExecResult = {
          exitCode,
          stdout: job.stdout,
          stderr: job.stderr,
          output: job.output,
          timedOut: timedOut || exitCode === 124 || exitCode === 137,
          durationMs: Date.now() - startedAt,
        };
        return result;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        job.stdout += chunk.toString();
        job.output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        job.stderr += chunk.toString();
        job.output += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(threshold);
        clearTimeout(guard);
        const result = finish(-1);
        result.output += `${err.message}
`;
        job.result = result;
        if (!settled) {
          settled = true;
          resolve(result);
        }
      });
      child.on("close", (code) => {
        clearTimeout(threshold);
        clearTimeout(guard);
        const result = finish(code ?? -1);
        job.result = result;
        if (!settled) {
          settled = true;
          this.jobs.delete(jobId);
          resolve(result);
        }
      });
    });
  }

  async openProcess(
    command: string,
    args: string[],
    opts: ProcessOptions = {},
  ): Promise<ProcessHandle> {
    this.assertUsable();
    if (this.processes.size >= 8) {
      throw new Error("docker sandbox process limit reached (8)");
    }
    const id = randomUUID();
    const timeoutSecs = clampTimeout(opts.timeoutSecs ?? 3600);
    const pidFile = `/tmp/anchor-process-${id}.pid`;
    const env = { ...this.spec.env, ...opts.env };
    const envFlags = Object.entries(env).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]);
    const script = `echo $$ > ${shq(pidFile)}; exec "$@"`;
    const child = spawn(
      this.dockerBin,
      [
        "exec",
        "-i",
        ...envFlags,
        "-w",
        opts.cwd ?? this.workspace,
        this.id,
        "bash",
        "-c",
        script,
        "anchor-process",
        command,
        ...args,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const handle = new ChildProcessHandle(id, child, {
      ...opts,
      timeoutSecs,
      processGroup: false,
      killGuest: async () => {
        await this.cli([
          "exec",
          this.id,
          "bash",
          "-c",
          `p=$(cat ${shq(pidFile)} 2>/dev/null) || exit 0; kill -TERM -$p 2>/dev/null || kill -TERM $p 2>/dev/null || true; rm -f ${shq(pidFile)}`,
        ], { timeoutSecs: 30 });
      },
      onClose: () => this.processes.delete(id),
    });
    this.processes.set(id, handle);
    return handle;
  }

  async pollJob(
    jobId: string,
  ): Promise<ExecResult | undefined> {
    const job = this.jobs.get(jobId);
    if (!job || !job.result) return undefined;
    this.jobs.delete(jobId);
    return job.result;
  }

  async killJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.child.kill("SIGKILL");
    this.jobs.delete(jobId);
    return true;
  }

  async killAllJobs(): Promise<number> {
    let killed = 0;
    for (const [id, job] of this.jobs) {
      job.child.kill("SIGKILL");
      this.jobs.delete(id);
      killed += 1;
    }
    return killed;
  }

  async checkpoint(
    message: string,
    opts?: { push?: string },
  ): Promise<Checkpoint> {
    this.assertUsable();
    return checkpointVia(this.gitAccess(), message, opts ?? {});
  }

  async hasChangesFrom(ref: string): Promise<boolean> {
    this.assertUsable();
    return hasChangesFromVia(this.gitAccess(), ref);
  }

  async fork(): Promise<Sandbox> {
    throw new Error(
      "fork() is not implemented for the docker backend yet — a new container from the image plus `git checkout <sha>` lands with best-of-N",
    );
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const handle of [...this.processes.values()]) {
      await handle.kill("SIGKILL").catch(() => undefined);
      await handle.wait().catch(() => undefined);
    }
    this.processes.clear();
    if (this.spec.keep || this.spec.retain) {
      if (!this.opts.quiet) {
        process.stderr.write(
          this.spec.keep
            ? `keeping container for debugging: ${this.id}\n`
            : `retained container for thread continuation: ${this.id}\n`,
        );
      }
      await this.cli(["stop", this.id], { timeoutSecs: 120 });
      return;
    }
    await this.cli(["rm", "-f", this.id], { timeoutSecs: 120 });
  }

  // --- internals -----------------------------------------------------------

  private assertUsable(): void {
    if (!this.started)
      throw new Error(`sandbox ${this.id} not started — call start() first`);
    if (this.destroyed) throw new Error(`sandbox ${this.id} was destroyed`);
  }

  private gitAccess(): GitAccess {
    return {
      git: async (args, opts) => {
        const r = await this.execRaw(
          `git ${args.map((arg) => shq(arg)).join(" ")}`,
          { timeoutSecs: opts?.timeoutSecs ?? 120 },
        );
        if (r.exitCode !== 0) {
          throw new Error(
            `git ${args.join(" ")} failed (${r.exitCode}): ${r.output.trim()}`,
          );
        }
        return r.stdout;
      },
      shell: (command, opts) => this.execRaw(command, opts),
    };
  }

  /** Run the docker CLI; the outer guard stops a wedged CLI itself. */
  private cli(
    args: string[],
    opts: { timeoutSecs?: number } = {},
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const child = spawn(this.dockerBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let output = "";
      let timedOut = false;

      const guard = setTimeout(
        () => {
          timedOut = true;
          child.kill("SIGKILL");
        },
        ((opts.timeoutSecs ?? 120) + 60) * 1000,
      );

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        output += chunk.toString();
      });

      child.on("error", (err) => {
        clearTimeout(guard);
        resolve({
          exitCode: -1,
          stdout,
          stderr,
          output: `${output}${err.message}\n`,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });

      child.on("close", (code) => {
        clearTimeout(guard);
        // The guest-side `timeout` reports 124 (SIGTERM) / 137 (SIGKILL) and
        // `docker exec` passes the command's exit code through.
        const exitCode = code ?? -1;
        resolve({
          exitCode,
          stdout,
          stderr,
          output,
          timedOut: timedOut || exitCode === 124 || exitCode === 137,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}

/** Local Docker containers as a sandbox provider. */
export function docker(opts: DockerSandboxOptions = {}): SandboxProvider {
  const dockerBin = opts.dockerBin ?? "docker";
  return {
    name: "docker",
    capabilities: {
      fork: false,
      retain: true,
      remoteCheckpoint: true,
      egressControl: true, // `--network none` shape via disconnect after setup
      localPath: false,
      processStream: true,
      publishImage: true,
      previewPort: false,
    },
    imagePublisher: dockerImagePublisher({ dockerBin: opts.dockerBin }),
    create: (spec) => new DockerSandbox(spec, opts),
    adopt: (handle, spec = {}) =>
      new DockerSandbox({ ...spec, adopt: handle.id }, opts),
    // Only "no container" is gone; a container that failed to wake is transient.
    isGone: (error) => error instanceof SandboxGoneError,
    release: async (handle) => {
      await new Promise<void>((resolve) => {
        const child = spawn(dockerBin, ["rm", "-f", handle.id], {
          stdio: "ignore",
        });
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      });
    },
    probe: async (): Promise<ProviderHealth> => {
      const r = await new Promise<{
        code: number | null;
        out: string;
        err: string;
      }>((resolve) => {
        const child = spawn(
          dockerBin,
          ["info", "--format", "{{.ServerVersion}} {{.Architecture}}"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
        child.on("close", (code) => resolve({ code, out, err }));
        child.on("error", (error) =>
          resolve({ code: -1, out, err: error.message }),
        );
      });
      if (r.code !== 0) {
        return {
          ok: false,
          name: "docker",
          detail: r.err.trim().split("\n")[0] ?? "unreachable",
        };
      }
      return {
        ok: true,
        name: "docker",
        detail: `server ${r.out.trim()}`,
      };
    },
  };
}
