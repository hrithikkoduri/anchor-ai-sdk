/**
 * LocalSandbox — the `Sandbox` interface implemented as plain processes on
 * this machine, in a scratch directory under `.anchor/sandboxes/`.
 *
 * NOT a sandbox: commands run with your user's full permissions on your Mac.
 * It exists so the agent loop, tools, and tests can be developed in
 * milliseconds without creating real VMs. Real runs — and anything untrusted —
 * use `HeyoSandbox`. It is injected explicitly (`--local` flag, tests) and can
 * never be selected by production configuration.
 *
 * It is deliberately as strict as a microVM, so code written against it
 * behaves identically on Heyo:
 *   - every exec is a fresh process; no `cd`/`export` survives between calls
 *   - the default cwd is the workspace, but nothing persists implicitly
 *   - timeouts kill the whole process tree (SIGTERM, then SIGKILL after grace)
 *   - checkpoints are plain git commits
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
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
import type { SandboxProvider } from "../provider.js";
import {
  checkpointVia,
  hasChangesFromVia,
  reservedScratchPrepCommand,
  type GitAccess,
} from "../git.js";

export interface LocalSandboxOptions {
  /** Where sandbox directories live. Default: `<cwd>/.anchor/sandboxes`. */
  rootDir?: string;
  /** Silence the "no isolation" warning (used by tests). */
  quiet?: boolean;
}

const KILL_GRACE_MS = 5_000;

export class LocalSandbox implements Sandbox {
  readonly backend = "local" as const;
  readonly id: string;
  /** The sandbox's scratch directory on the host. */
  readonly root: string;
  /** Lifecycle-scoped scratch for spills/notes — outside the repo. */
  readonly scratch: string;
  /** The repo directory — the local equivalent of /workspace/repo. */
  readonly workspace: string;

  private started = false;
  private destroyed = false;
  private readonly processes = new Map<string, ChildProcessHandle>();

  constructor(
    private readonly spec: SandboxSpec,
    private readonly opts: LocalSandboxOptions = {},
  ) {
    // Adopting points at the retained sandbox's directory — same workspace.
    this.id = spec.adopt ?? newSandboxId();
    this.root = path.join(
      opts.rootDir ?? path.join(process.cwd(), ".anchor", "sandboxes"),
      this.id,
    );
    this.workspace = path.join(this.root, "repo");
    this.scratch = path.join(this.root, "scratch");
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.spec.image || this.spec.workspacePath) {
      throw new Error(
        "the local backend has no per-sandbox image/workspacePath — use localPath for host directories, or the docker backend",
      );
    }
    if (this.spec.egress === "none") {
      throw new Error(
        "the local backend has no egress control — it runs commands on the host",
      );
    }
    if (!this.opts.quiet) {
      process.stderr.write(
        `\u26a0 running locally — no isolation (${this.id})\n`,
      );
    }

    if (this.spec.adopt) {
      // Adopt the retained directory: the workspace must still be there. A
      // missing workspace is the local backend's "gone" — the consumer clears
      // its pointer and builds fresh.
      if (!(await exists(path.join(this.workspace, ".git"))))
        throw new SandboxGoneError(
          `retained sandbox ${this.id} has no workspace`,
          this.id,
        );
      await this.git([
        "-C",
        this.workspace,
        "config",
        "user.name",
        this.spec.gitIdentity?.name ?? "anchor",
      ]);
      await this.git([
        "-C",
        this.workspace,
        "config",
        "user.email",
        this.spec.gitIdentity?.email ?? "anchor@localhost",
      ]);
      await this.prepareScratch();
      this.started = true;
      return;
    }

    await mkdir(this.root, { recursive: true });

    if (this.spec.localPath) {
      await cp(this.spec.localPath, this.workspace, { recursive: true });
    } else if (this.spec.repoUrl) {
      await this.git(["clone", "-q", this.spec.repoUrl, this.workspace]);
      if (this.spec.ref) {
        await this.git(["-C", this.workspace, "checkout", "-q", this.spec.ref]);
      }
    } else {
      await mkdir(this.workspace, { recursive: true });
    }

    // Checkpoints need a git repo; make one if the source wasn't one.
    if (!(await exists(path.join(this.workspace, ".git")))) {
      await this.git(["init", "-q", "-b", "main", this.workspace]);
    }
    await this.git([
      "-C",
      this.workspace,
      "config",
      "user.name",
      this.spec.gitIdentity?.name ?? "anchor",
    ]);
    await this.git([
      "-C",
      this.workspace,
      "config",
      "user.email",
      this.spec.gitIdentity?.email ?? "anchor@localhost",
    ]);
    await this.prepareScratch();

    this.started = true;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertUsable();
    const timeoutSecs = clampTimeout(opts.timeoutSecs);
    const cwd = opts.cwd ?? this.workspace;
    const env = { ...this.spec.env, ...opts.env };
    return this.run("bash", ["-c", command], cwd, env, timeoutSecs);
  }

  async openProcess(
    command: string,
    args: string[],
    opts: ProcessOptions = {},
  ): Promise<ProcessHandle> {
    this.assertUsable();
    if (this.processes.size >= 8) {
      throw new Error("local sandbox process limit reached (8)");
    }
    const id = randomUUID();
    const timeoutSecs = clampTimeout(opts.timeoutSecs ?? 3600);
    const child = spawn(command, args, {
      cwd: opts.cwd ?? this.workspace,
      env: { ...process.env, ...this.spec.env, ...opts.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const handle = new ChildProcessHandle(id, child, {
      ...opts,
      timeoutSecs,
      processGroup: true,
      onClose: () => this.processes.delete(id),
    });
    this.processes.set(id, handle);
    return handle;
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

  async fork(ref?: string): Promise<Sandbox> {
    this.assertUsable();
    // Copy the current workspace (files + .git) into a fresh sandbox, then
    // FORCE-checkout the requested commit: the fork is exactly that checkpoint,
    // and uncommitted working-tree changes are not carried over (a plain
    // checkout preserves local modifications when ref == HEAD — learned by a
    // failing test).
    const child = new LocalSandbox(
      { localPath: this.workspace, keep: this.spec.keep },
      this.opts,
    );
    await child.start();
    const target = ref ?? "HEAD";
    // Untracked files are working-tree state too, and the contract says a fork
    // carries none of it. `git clean -fd` leaves git-excluded paths (`.anchor`)
    // alone, which is what the e2b backend does as well.
    const checkout = await child.exec(
      `git checkout -q -f ${shq(target)} && git clean -fd`,
      { timeoutSecs: 60 },
    );
    if (checkout.exitCode !== 0) {
      await child.destroy();
      throw new Error(
        `fork: checkout ${target} failed: ${checkout.output.trim()}`,
      );
    }
    return child;
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
      process.stderr.write(
        this.spec.keep
          ? `keeping sandbox for debugging: ${this.root}\n`
          : `retained sandbox for thread continuation: ${this.root}\n`,
      );
      return;
    }
    await rm(this.root, { recursive: true, force: true });
  }

  // --- internals -----------------------------------------------------------

  private assertUsable(): void {
    if (!this.started)
      throw new Error(`sandbox ${this.id} not started — call start() first`);
    if (this.destroyed) throw new Error(`sandbox ${this.id} was destroyed`);
  }

  /** Internal git helper — throws on failure, unlike exec (which reports). */
  private git(args: string[]): Promise<string> {
    return this.gitAt(this.root, args);
  }

  /** git in a specific directory; throws on failure with output in the message. */
  private async gitAt(
    cwd: string,
    args: string[],
    opts: { timeoutSecs?: number } = {},
  ): Promise<string> {
    const r = await this.run("git", args, cwd, {}, opts.timeoutSecs ?? 120);
    if (r.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (${r.exitCode}): ${r.output.trim()}`,
      );
    }
    return r.stdout;
  }

  private gitAccess(): GitAccess {
    return {
      git: (args, opts) => this.gitAt(this.workspace, args, opts ?? {}),
      shell: (command, opts) => this.exec(command, opts),
    };
  }

  /** The reserved .anchor dir: git-excluded (status/diff), checkpoint-carried. */
  private async prepareScratch(): Promise<void> {
    await this.run(
      "bash",
      ["-c", reservedScratchPrepCommand()],
      this.workspace,
      {},
      60,
    );
  }

  private run(
    cmd: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    timeoutSecs: number,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        // Own process group, so the kill below reaches children too
        // (`npm test` spawns node, which spawns test workers, ...).
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let output = "";
      let timedOut = false;

      const killGroup = (signal: NodeJS.Signals) => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          process.kill(-pid, signal); // negative pid = whole process group
        } catch {
          // Group already gone — nothing to kill.
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        forceTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
      }, timeoutSecs * 1000);
      let forceTimer: ReturnType<typeof setTimeout> | undefined;

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        output += chunk.toString();
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        resolve({
          exitCode: -1,
          stdout,
          stderr,
          output: `${output}${err.message}\n`,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        // Report timeout kills with the conventional shell codes:
        // 124 = timed out (SIGTERM), 137 = killed hard (128 + SIGKILL).
        let exitCode = code ?? -1;
        if (timedOut && code === null)
          exitCode = signal === "SIGKILL" ? 137 : 124;
        resolve({
          exitCode,
          stdout,
          stderr,
          output,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The host machine as a sandbox provider — dev and tests; never isolation. */
export function local(opts: LocalSandboxOptions = {}): SandboxProvider {
  return {
    name: "local",
    capabilities: {
      fork: true, // real: fork() copies the workspace dir at a checkpoint
      retain: true,
      remoteCheckpoint: true, // file-backed pushes to a host origin work
      egressControl: false,
      localPath: true,
      processStream: true,
      previewPort: false,
    },
    create: (spec) => new LocalSandbox(spec, opts),
    adopt: (handle, spec = {}) =>
      new LocalSandbox({ ...spec, adopt: handle.id }, opts),
    // Only a missing workspace is "gone"; anything else (a git write that
    // failed) is transient and must not discard the retained pointer.
    isGone: (error) => error instanceof SandboxGoneError,
    release: async (handle) => {
      await new LocalSandbox({ adopt: handle.id }, opts).destroy();
    },
    probe: async () => ({ ok: true, name: "local" }),
  };
}
