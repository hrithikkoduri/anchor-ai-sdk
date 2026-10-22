/**
 * E2BSandbox — the `Sandbox` interface on E2B cloud sandboxes.
 *
 * E2B is a remote VM provider with the primitives this contract needs:
 * create/connect, pause/resume, kill, fork, snapshots, and per-command
 * timeouts. The adapter maps those onto the same lifecycle as `local`,
 * `docker`, and `heyo`; everything above the sandbox (engine, tools, traces)
 * stays provider-agnostic.
 *
 * `SandboxSpec.image` is interpreted as an E2B **template name or ID** —
 * E2B does not boot arbitrary Docker images at sandbox-create time. Build a
 * template first (`Template().fromDockerfile(...)` / `fromImage(...)`) and
 * pass its name here. `template` is the default when a spec names none.
 *
 * The timeout rule is the repo-wide one: E2B's `timeoutMs` is a control-plane
 * deadline, so every command is wrapped in guest-side `timeout -k` and exit
 * 124/137 is reported as `timedOut`.
 */
import { randomUUID } from "node:crypto";
import {
  CommandExitError,
  type CommandHandle,
  Sandbox as E2BClient,
  SandboxNotFoundError,
  type SandboxConnectOpts,
  type SandboxInfo,
  type SandboxOpts,
} from "e2b";
import type { ProviderHealth, SandboxProvider } from "../provider.js";
import {
  clampTimeout,
  shq,
  type Checkpoint,
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  type SandboxSpec,
  type ProcessHandle,
  type ProcessOptions,
} from "../types.js";
import { ByteQueue } from "../process.js";
import {
  checkpointVia,
  hasChangesFromVia,
  reservedScratchPrepCommand,
  type GitAccess,
} from "../git.js";
import {
  e2bCommand,
  e2bResult,
  e2bTransportFailure,
  killE2bCommand,
} from "./exec.js";

/** Default workspace for a repo cloned by this adapter. */
const DEFAULT_WORKSPACE = "/home/user/repo";
/** Lifecycle-scoped scratch, outside the repo (spills, notes). */
const DEFAULT_SCRATCH = "/tmp/anchor";
/**
 * Default sandbox lifetime (wall-clock). E2B kills on timeout unless a
 * lifecycle is configured; retention is handled explicitly at destroy().
 * Hobby caps at 1 hour, Pro at 24 hours — raise this with `timeoutMs`.
 */
const DEFAULT_LIFETIME_MS = 60 * 60_000;
/** Reuse a minted git token for this long (installation tokens live for hours). */
const GIT_TOKEN_TTL_MS = 5 * 60_000;

export interface E2BSandboxOptions {
  /** E2B API key. Omit to let the SDK read `E2B_API_KEY`. */
  apiKey?: string;
  /** E2B domain, for self-hosted/region-specific control planes. */
  domain?: string;
  /**
   * Default E2B template for sandboxes whose spec names none. Must contain
   * `bash`, `git`, `coreutils` (including `timeout`), and the language
   * toolchain the task needs. The public `base` template is the fallback.
   */
  template?: string;
  /** Sandbox lifetime in milliseconds (default 1 hour; Pro can go to 24h). */
  timeoutMs?: number;
  /** Default workspace path when the spec names none. */
  cwd?: string;
  /** Scratch directory inside the sandbox (default `/tmp/anchor`). */
  scratch?: string;
  /** User to run commands as (the template's default when omitted). */
  user?: string;
  /** Silence lifecycle notes (tests). */
  quiet?: boolean;
  /**
   * Test seam: the two network entry points. Defaults to the E2B SDK, so a
   * unit test can exercise start/fork/adopt without an account.
   */
  clientFactory?: E2BClientFactory;
}

/** The create/connect pair, injectable so the adapter is testable offline. */
export interface E2BClientFactory {
  create(template: string, opts: SandboxOpts): Promise<E2BClient>;
  connect(sandboxId: string, opts: SandboxConnectOpts): Promise<E2BClient>;
}

const defaultFactory: E2BClientFactory = {
  create: (template, opts) => E2BClient.create(template, opts),
  connect: (sandboxId, opts) => E2BClient.connect(sandboxId, opts),
};

function connectionOpts(opts: E2BSandboxOptions): {
  apiKey?: string;
  domain?: string;
} {
  return {
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.domain ? { domain: opts.domain } : {}),
  };
}

export class E2BSandbox implements Sandbox {
  readonly backend = "e2b" as const;

  private _id: string;
  private _workspace: string;
  private _scratch: string;
  private client?: E2BClient;
  private started = false;
  private destroyed = false;
  private readonly factory: E2BClientFactory;
  private readonly processes = new Set<CommandHandle>();
  /** Git tokens are installation tokens (hours); cache one briefly. */
  private gitToken?: { value: string; at: number };

  constructor(
    private readonly spec: SandboxSpec,
    private readonly opts: E2BSandboxOptions = {},
  ) {
    this._id = spec.adopt ?? "pending";
    this._workspace = spec.workspacePath ?? opts.cwd ?? DEFAULT_WORKSPACE;
    this._scratch = opts.scratch ?? DEFAULT_SCRATCH;
    this.factory = opts.clientFactory ?? defaultFactory;
  }

  get id(): string {
    return this._id;
  }

  get workspace(): string {
    return this._workspace;
  }

  get scratch(): string {
    return this._scratch;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.spec.localPath) {
      throw new Error(
        "the e2b backend has no host-path access — pass repoUrl, workspacePath, or use local()",
      );
    }
    if (this.spec.egress === "none") {
      throw new Error(
        "the e2b backend has no egress control yet — it declares egressControl: false",
      );
    }
    let created = false;

    try {
      if (this.spec.adopt) {
        // Wake the retained sandbox. `connect` resumes a paused one; the
        // workspace comes from the retained disk, not from the spec.
        this.client = await this.factory.connect(this.spec.adopt, {
          ...connectionOpts(this.opts),
          timeoutMs: this.lifetimeMs(),
        });
        this._id = this.client.sandboxId;
        this.applyMetadata(await this.client.getInfo());

        const workspace = await this.execRaw(
          `test -d ${shq(this._workspace)}/.git`,
          { cwd: "/", timeoutSecs: 60 },
        );
        if (workspace.exitCode !== 0) {
          throw new Error(
            `retained sandbox ${this._id} has no workspace at ${this._workspace}`,
          );
        }
      } else {
        const template = this.spec.image ?? this.opts.template ?? "base";
        try {
          this.client = await this.factory.create(template, {
            ...connectionOpts(this.opts),
            timeoutMs: this.lifetimeMs(),
            ...(this.spec.env ? { envs: this.spec.env } : {}),
            // Store the coordinates on the sandbox so an `openSandboxSession`
            // adoption does not have to guess them from the caller's sources.
            metadata: {
              anchorWorkspace: this._workspace,
              anchorScratch: this._scratch,
            },
          });
        } catch (error) {
          // The commonest mistake is passing a Docker image where a template
          // belongs; E2B's own "not found" does not say that.
          throw new Error(
            `could not create an E2B sandbox from "${template}": ` +
              `${error instanceof Error ? error.message : String(error)} — ` +
              `E2B boots templates, not Docker images. Build one with ` +
              `Template().fromImage(...) and pass its name as template or spec.image.`,
          );
        }
        created = true;
        this._id = this.client.sandboxId;
        await this.prepareWorkspace();
      }

      await this.configureGit();
      // The reserved .anchor dir: git-excluded (status/diff), checkpoint-carried.
      await this.execRaw(reservedScratchPrepCommand(), { timeoutSecs: 60 });

      this.started = true;
    } catch (error) {
      // A failed start must not leak the sandbox it just created. An adopted
      // sandbox is not ours to kill — it belongs to its owner.
      if (created && this.client) {
        await this.client.kill().catch(() => undefined);
      }
      throw error;
    }
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertUsable();
    return this.execRaw(command, opts);
  }

  async openProcess(
    command: string,
    args: string[],
    opts: ProcessOptions = {},
  ): Promise<ProcessHandle> {
    this.assertUsable();
    if (this.processes.size >= 8) {
      throw new Error("e2b sandbox process limit reached (8)");
    }
    const client = this.client!;
    const timeoutSecs = clampTimeout(opts.timeoutSecs ?? 3600);
    const envs = {
      ...this.spec.env,
      ...(await this.gitEnv()),
      ...opts.env,
    };
    const stdout = new ByteQueue();
    const stderr = new ByteQueue();
    const line = [command, ...args].map(shq).join(" ");
    const handle = await client.commands.run(line, {
      background: true,
      stdin: true,
      cwd: opts.cwd ?? this._workspace,
      envs,
      ...(this.opts.user ? { user: this.opts.user } : {}),
      timeoutMs: timeoutSecs * 1000,
      onStdout: (data: string) => stdout.push(Buffer.from(data)),
      onStderr: (data: string) => stderr.push(Buffer.from(data)),
    });
    this.processes.add(handle);
    let killed = false;
    let timedOut = false;
    let finished:
      | { exitCode: number; signal?: string; timedOut: boolean }
      | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      void handle.kill().catch(() => false);
    }, timeoutSecs * 1000);
    const abort = () => {
      timedOut = true;
      killed = true;
      void handle.kill().catch(() => false);
    };
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      stdout.close();
      stderr.close();
      this.processes.delete(handle);
      return { exitCode, timedOut };
    };
    const exitPromise = (async () => {
      try {
        const result = await handle.wait();
        finished = finish(result.exitCode ?? 0);
      } catch (error) {
        if (error instanceof CommandExitError) {
          finished = finish(error.exitCode);
        } else {
          throw error;
        }
      }
      return finished;
    })();
    return {
      id: String(handle.pid),
      stdout,
      stderr,
      write: (data) => handle.sendStdin(data),
      endInput: () => handle.closeStdin(),
      wait: () => exitPromise,
      kill: async (signal) => {
        if (finished) return false;
        killed = true;
        void signal;
        const did = await handle.kill().catch(() => false);
        if (did) finished = finish(137);
        return did;
      },
    };
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
    // E2B snapshots the current state (including uncommitted work). Anchor's
    // fork contract is a CLEAN checkpoint state, so reset the tracked tree and
    // drop untracked files after attaching. `.anchor/` is git-excluded, so it
    // survives `git clean -fd`.
    const forks = await this.client!.fork({
      count: 1,
      timeoutMs: this.lifetimeMs(),
    });
    const first = forks[0];
    if (!first || first instanceof Error) {
      throw new Error(
        `E2B fork failed: ${first instanceof Error ? first.message : "no sandbox returned"}`,
      );
    }

    const child = new E2BSandbox(
      {
        ...this.spec,
        adopt: first.sandboxId,
        workspacePath: this._workspace,
      },
      this.opts,
    );
    await child.attach(first);

    const target = ref ?? "HEAD";
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
    for (const handle of [...this.processes]) {
      await handle.kill().catch(() => false);
    }
    this.processes.clear();
    const client = this.client;
    if (!client) return;

    // `keep` is the debugging switch: leave it running for a human to inspect
    // (the sandbox's own timeout eventually pauses or kills it).
    if (this.spec.keep) {
      if (!this.opts.quiet) {
        process.stderr.write(
          `keeping E2B sandbox for debugging: ${this._id}\n`,
        );
      }
      return;
    }

    // `retain` is thread continuity: pause so the next run can adopt it with
    // the workspace (and memory) intact, without paying for a running VM.
    if (this.spec.retain) {
      await client.pause().catch((error) => {
        if (!(error instanceof SandboxNotFoundError) && !this.opts.quiet) {
          process.stderr.write(
            `could not pause E2B sandbox ${this._id}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      });
      if (!this.opts.quiet) {
        process.stderr.write(
          `retained E2B sandbox for thread continuation: ${this._id}\n`,
        );
      }
      return;
    }

    await client.kill().catch((error) => {
      // Already gone is not an error; a transport failure is worth reporting
      // but must not turn cleanup into a run-ending throw.
      if (!(error instanceof SandboxNotFoundError) && !this.opts.quiet) {
        process.stderr.write(
          `could not kill E2B sandbox ${this._id}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    });
  }

  // --- internals -----------------------------------------------------------

  private lifetimeMs(): number {
    return this.opts.timeoutMs ?? DEFAULT_LIFETIME_MS;
  }

  private assertUsable(): void {
    if (!this.started) {
      throw new Error(`sandbox ${this._id} not started — call start() first`);
    }
    if (this.destroyed) {
      throw new Error(`sandbox ${this._id} was destroyed`);
    }
  }

  /** Read the coordinates stored at create time; an explicit option wins. */
  private applyMetadata(info: SandboxInfo): void {
    if (!this.spec.workspacePath) {
      const workspace = info.metadata?.anchorWorkspace;
      if (typeof workspace === "string" && workspace.trim() !== "") {
        this._workspace = workspace;
      }
    }
    if (this.opts.scratch === undefined) {
      const scratch = info.metadata?.anchorScratch;
      if (typeof scratch === "string" && scratch.trim() !== "") {
        this._scratch = scratch;
      }
    }
  }

  /** Attach to an already-connected E2B sandbox (the fork path). */
  private async attach(client: E2BClient): Promise<void> {
    this.client = client;
    this._id = client.sandboxId;
    this.applyMetadata(await client.getInfo());
    this.started = true;
  }

  private async prepareWorkspace(): Promise<void> {
    const workspace = this._workspace;

    if (this.spec.workspacePath) {
      const present = await this.execRaw(`test -d ${shq(workspace)}`, {
        cwd: "/",
        timeoutSecs: 60,
      });
      if (present.exitCode !== 0) {
        throw new Error(
          `workspacePath ${workspace} does not exist in the sandbox`,
        );
      }
      // configureGit() runs in the workspace right after this; fail with the
      // path named rather than with a bare "git config failed".
      const git = await this.execRaw(`test -d ${shq(`${workspace}/.git`)}`, {
        cwd: "/",
        timeoutSecs: 60,
      });
      if (git.exitCode !== 0) {
        throw new Error(
          `workspacePath ${workspace} is not a git repository — the adapter needs .git there for checkpoints and diffs`,
        );
      }
      return;
    }

    if (this.spec.repoUrl) {
      const helper = this.credentialHelper();
      const credential = helper
        ? `-c ${shq(`credential.helper=${helper}`)} `
        : "";
      const clone = await this.execRaw(
        `git ${credential}clone --quiet ${shq(this.spec.repoUrl)} ${shq(workspace)}`,
        { cwd: "/", timeoutSecs: 900 },
      );
      if (clone.exitCode !== 0) {
        throw new Error(
          `git clone failed: ${clone.output.trim().slice(0, 500)}`,
        );
      }
      if (this.spec.ref) {
        const checkout = await this.execRaw(
          `git -C ${shq(workspace)} checkout --quiet ${shq(this.spec.ref)}`,
          { cwd: "/", timeoutSecs: 120 },
        );
        if (checkout.exitCode !== 0) {
          throw new Error(
            `git checkout ${this.spec.ref} failed: ${checkout.output.trim()}`,
          );
        }
      }
      return;
    }

    await this.execRaw(`mkdir -p ${shq(workspace)}`, {
      cwd: "/",
      timeoutSecs: 60,
    });
    const hasGit = await this.execRaw(`test -d ${shq(`${workspace}/.git`)}`, {
      cwd: "/",
      timeoutSecs: 60,
    });
    if (hasGit.exitCode !== 0) {
      const init = await this.execRaw(`git init -q -b main ${shq(workspace)}`, {
        cwd: "/",
        timeoutSecs: 120,
      });
      if (init.exitCode !== 0) {
        throw new Error(`git init failed: ${init.output.trim()}`);
      }
    }
  }

  private async configureGit(): Promise<void> {
    const access = this.gitAccess();
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

    // Credentials are a callback (installation tokens expire mid-run). The
    // helper reads GIT_TOKEN from each command's env; the token never enters
    // the workspace or the git config.
    const helper = this.credentialHelper();
    if (helper) {
      await access.git(["config", "credential.helper", helper]);
      await access.git(["config", "credential.useHttpPath", "true"]);
    }
  }

  private credentialHelper(): string | undefined {
    if (!this.spec.git) return undefined;
    const username = this.spec.git.username ?? "x-access-token";
    return `!f() { echo username=${username}; printf 'password=%s\\n' "$GIT_TOKEN"; }; f`;
  }

  /**
   * The git token for one command. Minted once and reused briefly: a callback
   * that hits GitHub would otherwise run on every command, including the ones
   * that never touch the network.
   */
  private async gitEnv(): Promise<Record<string, string>> {
    if (!this.spec.git) return {};
    const now = Date.now();
    if (!this.gitToken || now - this.gitToken.at > GIT_TOKEN_TTL_MS) {
      this.gitToken = { value: await this.spec.git.token(), at: now };
    }
    return { GIT_TOKEN: this.gitToken.value };
  }

  private gitAccess(): GitAccess {
    return {
      git: async (args, opts) => {
        const result = await this.execRaw(
          `git ${args.map((arg) => shq(arg)).join(" ")}`,
          { timeoutSecs: opts?.timeoutSecs ?? 120 },
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `git ${args.join(" ")} failed (${result.exitCode}): ${result.output.trim()}`,
          );
        }
        return result.stdout;
      },
      shell: (command, opts) => this.execRaw(command, opts),
    };
  }

  /** Exec without the started guard — start()'s own setup uses this. */
  private async execRaw(
    command: string,
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    const client = this.client;
    if (!client) {
      throw new Error(
        `sandbox ${this._id} has no E2B client — call start() first`,
      );
    }

    const timeoutSecs = clampTimeout(opts.timeoutSecs);
    const cwd = opts.cwd ?? this._workspace;
    const envs = {
      ...this.spec.env,
      ...(await this.gitEnv()),
      ...opts.env,
    };
    const startedAt = Date.now();

    // Collect both streams in arrival order: E2B returns them separately, but
    // ExecResult.output promises the interleaving the command produced.
    let stdout = "";
    let stderr = "";
    let output = "";

    // A cancelled run kills the guest process (E2B's timeoutMs is only a
    // transport guard, not a kill) and resolves as `cancelled` promptly.
    // The real run is started ONCE; the abort race only decides whether we
    // keep waiting for it — losing the race must not re-execute a mutation.
    const runOptions = {
      cwd: "/",
      envs,
      // The guest-side `timeout` is the real kill; this is only a slightly
      // longer transport guard so a wedged RPC cannot hang the run.
      timeoutMs: (timeoutSecs + 30) * 1000,
      ...(this.opts.user ? { user: this.opts.user } : {}),
      onStdout: (data: string) => {
        stdout += data;
        output += data;
      },
      onStderr: (data: string) => {
        stderr += data;
        output += data;
      },
    } satisfies Parameters<typeof client.commands.run>[1];
    const pidFile = `/tmp/anchor-e2b-${randomUUID()}.pid`;
    const pending = client.commands.run(
      e2bCommand(command, cwd, timeoutSecs, pidFile),
      runOptions,
    );

    const abortSignal = opts.signal;
    let abortListener: (() => void) | undefined;
    if (abortSignal) {
      if (abortSignal.aborted) {
        await killE2bCommand(client, pidFile, command);
        return {
          exitCode: 130,
          stdout,
          stderr,
          output: `${output}Command cancelled by signal after ${((Date.now() - startedAt) / 1000).toFixed(1)}s; the E2B process was killed.`,
          timedOut: false,
          durationMs: Date.now() - startedAt,
          cancelled: true,
        };
      }
      const raced = await Promise.race([
        new Promise<"aborted">((resolve) => {
          abortListener = () => resolve("aborted");
          abortSignal.addEventListener("abort", abortListener, { once: true });
        }),
        pending.then(
          () => "completed" as const,
          () => "completed" as const,
        ),
      ]);
      if (raced === "aborted") {
        await killE2bCommand(client, pidFile, command);
        return {
          exitCode: 130,
          stdout,
          stderr,
          output: `${output}Command cancelled by signal after ${((Date.now() - startedAt) / 1000).toFixed(1)}s; the E2B process was killed.`,
          timedOut: false,
          durationMs: Date.now() - startedAt,
          cancelled: true,
        };
      }
    }

    try {
      const result = await pending;
      return e2bResult(
        {
          exitCode: result.exitCode,
          stdout: stdout || result.stdout,
          stderr: stderr || result.stderr,
        },
        startedAt,
        { output: output || `${result.stdout}${result.stderr}` },
      );
    } catch (error) {
      // `commands.run()` throws on a non-zero exit; the thrown error still
      // carries the real result, which is a tool result, not a transport bug.
      if (error instanceof CommandExitError) {
        return e2bResult(
          {
            exitCode: error.exitCode,
            stdout: stdout || error.stdout,
            stderr: stderr || error.stderr,
            error: error.error,
          },
          startedAt,
          { output: output || `${error.stdout}${error.stderr}` },
        );
      }
      return e2bTransportFailure(
        error instanceof Error ? error.message : String(error),
        startedAt,
      );
    } finally {
      if (abortSignal && abortListener)
        abortSignal.removeEventListener("abort", abortListener);
    }
  }
}

/** E2B cloud sandboxes as a provider. */
export function e2b(opts: E2BSandboxOptions = {}): SandboxProvider {
  return {
    name: "e2b",
    capabilities: {
      fork: true, // native `sandbox.fork()` snapshots the running VM
      retain: true, // pause / connect
      remoteCheckpoint: true, // git push over the sandbox's network
      egressControl: false, // not exposed by this adapter yet
      localPath: false, // remote VM; no host-directory import
      processStream: true,
    },
    create: (spec) => new E2BSandbox(spec, opts),
    adopt: (handle, spec = {}) =>
      new E2BSandbox({ ...spec, adopt: handle.id }, opts),
    release: async (handle) => {
      try {
        await E2BClient.kill(handle.id, connectionOpts(opts));
      } catch (error) {
        // Already-gone is not an error; a transport failure is reported but
        // must not turn release into a throw the caller has to handle.
        if (!(error instanceof SandboxNotFoundError) && !opts.quiet) {
          process.stderr.write(
            `could not release E2B sandbox ${handle.id}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    },
    probe: async (): Promise<ProviderHealth> => {
      try {
        const paginator = E2BClient.list({
          limit: 1,
          ...connectionOpts(opts),
        });
        await paginator.nextItems();
        return {
          ok: true,
          name: "e2b",
          detail: `template ${opts.template ?? "base"}`,
        };
      } catch (error) {
        return {
          ok: false,
          name: "e2b",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
