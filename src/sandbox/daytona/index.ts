/**
 * DaytonaSandbox — the `Sandbox` interface on Daytona cloud sandboxes.
 *
 * Daytona is a remote sandbox provider whose primitives map onto this contract
 * unevenly, so the adapter declares exactly that (capabilities are promises the
 * conformance suite holds you to):
 *
 *   retain            yes — `destroy()` STOPS a retained sandbox; `adopt()`
 *                     re-opens it by id and starts it again. The filesystem
 *                     survives a stop/start cycle.
 *   remoteCheckpoint  yes — checkpoints push over the sandbox's own network.
 *   fork              NO  — the API answers 422 "Forking is not supported for
 *                     this sandbox" for the container-class sandboxes this
 *                     adapter creates. `fork()` throws with that reason and
 *                     the conformance fork scenario is skipped.
 *   egressControl     NO  — `networkBlockAll` is settable at CREATE time only,
 *                     and `start()` needs network to clone. Post-create
 *                     `updateNetworkSettings()` is rejected on restricted
 *                     tiers. `spec.egress: "none"` is rejected loudly rather
 *                     than run with network.
 *   processStream     NO  — see "Why no openProcess()" below.
 *   publishImage      no  — snapshot creation is a separate credentialed
 *                     service; this adapter does not own that seam.
 *
 * `SandboxSpec.image` is a **container image** reference (Daytona builds it
 * dynamically, e.g. `"ubuntu:24.04"`). A prebuilt snapshot goes in the
 * provider's `snapshot` option instead — Daytona's `create()` takes `image`
 * or `snapshot`, never both. When neither is named, Daytona's account default
 * snapshot is used; it ships bash, git, coreutils (`timeout`), python, and node.
 *
 * Exec runs as a **session** command: `process.executeCommand()` merges stderr
 * into stdout, while `executeSessionCommand()` reports stdout, stderr, and the
 * exit code separately — the fidelity `ExecResult` promises. Every call creates
 * and deletes its own short-lived session, so commands stay self-contained (no
 * state leaks) and read-only execs never contend for one slot.
 *
 * Why no `openProcess()`: Daytona's PTY is an interactive shell (it echoes
 * input, emits prompt escapes, and only "exits" when the shell does), and a
 * session command has no stdin EOF (Ctrl-D arrives as literal data). Neither
 * can honestly implement the stdin/stdout/stderr contract, and the README is
 * explicit that a provider must omit `openProcess` rather than fake it.
 */
import { Daytona, DaytonaNotFoundError } from "@daytonaio/sdk";
import type {
  ProviderHealth,
  SandboxCapabilities,
  SandboxProvider,
} from "../provider.js";
import {
  clampTimeout,
  newSandboxId,
  shq,
  type Checkpoint,
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  type SandboxSpec,
} from "../types.js";
import {
  checkpointVia,
  hasChangesFromVia,
  reservedScratchPrepCommand,
  type GitAccess,
} from "../git.js";
import {
  daytonaCommand,
  daytonaResult,
  daytonaTransportFailure,
  type DaytonaCommandResult,
} from "./exec.js";

/** Default workspace for a repo cloned by this adapter. */
const DEFAULT_WORKSPACE = "/home/daytona/repo";
/** Lifecycle-scoped scratch, outside the repo (spills, notes). */
const DEFAULT_SCRATCH = "/tmp/anchor";
/** Reuse a minted git token for this long (installation tokens live for hours). */
const GIT_TOKEN_TTL_MS = 5 * 60_000;
/**
 * Auto-stop floor (minutes). 0 disables Daytona's 15-minute default: a run can
 * outlive it, and retention is handled explicitly at `destroy()`.
 */
const DEFAULT_AUTO_STOP_MINUTES = 0;
/** How long create/start may take before the control plane gives up. */
const START_TIMEOUT_SECS = 300;

/**
 * Daytona's honest capability declaration — the values the real adapter honors,
 * replacing the stub's placeholders. `previewPort` is false: `getPreviewLink()`
 * returns a URL, but against a live sandbox the proxy answers 502 for a guest
 * server that is listening on 0.0.0.0, so no preview is claimed.
 */
export const daytonaCapabilities: SandboxCapabilities = {
  fork: false,
  retain: true,
  remoteCheckpoint: true,
  egressControl: false,
  localPath: false,
  processStream: false,
  previewPort: false,
};

export interface DaytonaSandboxOptions {
  /** Daytona API key. Omit to let the SDK read `DAYTONA_API_KEY`. */
  apiKey?: string;
  /** Organization id for JWT-based auth (`DAYTONA_ORGANIZATION_ID`). */
  organizationId?: string;
  /** Control-plane URL, for self-hosted/region-specific deployments. */
  apiUrl?: string;
  /** Default region (`DAYTONA_TARGET`). */
  target?: string;
  /**
   * Default snapshot for sandboxes whose spec names no image. Must contain
   * `bash`, `git`, and coreutils including `timeout`; the account default
   * snapshot does.
   */
  snapshot?: string;
  /** Default workspace path when the spec names none (`<home>/repo`). */
  cwd?: string;
  /** Scratch directory inside the sandbox (default `/tmp/anchor`). */
  scratch?: string;
  /** OS user to run commands as (the sandbox's own default when omitted). */
  user?: string;
  /** Auto-stop interval in minutes (0 disables it; the default here). */
  autoStopInterval?: number;
  /** Auto-archive interval in minutes (Daytona's default when omitted). */
  autoArchiveInterval?: number;
  /** Auto-delete interval in minutes (Daytona's default when omitted). */
  autoDeleteInterval?: number;
  /** Silence lifecycle notes (tests). */
  quiet?: boolean;
  /**
   * Test seam: the two control-plane entry points. Defaults to the Daytona
   * SDK, so a unit test can exercise start/adopt/destroy without an account.
   */
  clientFactory?: DaytonaClientFactory;
}

/** The create/get pair, injectable so the adapter is testable offline. */
export interface DaytonaClientFactory {
  create(
    params: Record<string, unknown>,
    options: { timeout: number },
  ): Promise<DaytonaSandboxClient>;
  get(idOrName: string): Promise<DaytonaSandboxClient>;
}

/** The subset of Daytona's `Sandbox` object this adapter drives. */
export interface DaytonaSandboxClient {
  id: string;
  state?: string;
  start(timeout?: number): Promise<void>;
  stop(timeout?: number, force?: boolean): Promise<void>;
  delete(timeout?: number, wait?: boolean): Promise<void>;
  getUserHomeDir?(): Promise<string | undefined>;
  process: {
    createSession(sessionId: string): Promise<void>;
    executeSessionCommand(
      sessionId: string,
      req: { command: string },
      timeout?: number,
    ): Promise<DaytonaCommandResult>;
    deleteSession(sessionId: string): Promise<void>;
  };
}

/** The SDK config this adapter forwards, built from options (never env reads). */
function configOf(opts: DaytonaSandboxOptions): {
  apiKey?: string;
  organizationId?: string;
  apiUrl?: string;
  target?: string;
} {
  return {
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.target ? { target: opts.target } : {}),
  };
}

function defaultFactory(opts: DaytonaSandboxOptions): DaytonaClientFactory {
  return {
    create: (params, options) =>
      new Daytona(configOf(opts)).create(params as never, options) as Promise<
        unknown
      > as Promise<DaytonaSandboxClient>,
    get: (idOrName) =>
      new Daytona(configOf(opts)).get(idOrName) as unknown as Promise<
        DaytonaSandboxClient
      >,
  };
}

export class DaytonaSandbox implements Sandbox {
  readonly backend = "daytona" as const;

  private _id: string;
  private _workspace: string;
  private _scratch: string;
  private client?: DaytonaSandboxClient;
  private started = false;
  private destroyed = false;
  private readonly factory: DaytonaClientFactory;
  /** Git tokens are installation tokens (hours); cache one briefly. */
  private gitToken?: { value: string; at: number };
  /** Per-call session ids, so concurrent execs never share one. */
  private sessionSeq = 0;

  constructor(
    private readonly spec: SandboxSpec,
    private readonly opts: DaytonaSandboxOptions = {},
  ) {
    this._id = spec.adopt ?? newSandboxId();
    this._workspace = spec.workspacePath ?? opts.cwd ?? DEFAULT_WORKSPACE;
    this._scratch = opts.scratch ?? DEFAULT_SCRATCH;
    this.factory = opts.clientFactory ?? defaultFactory(opts);
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
        "the daytona backend has no host-path access — pass repoUrl, workspacePath, or use local()",
      );
    }
    if (this.spec.egress === "none") {
      throw new Error(
        "the daytona backend cannot cut egress after setup — networkBlockAll is create-time only " +
          "and this adapter needs network to clone. It declares egressControl: false.",
      );
    }
    let created = false;

    try {
      if (this.spec.adopt) {
        // Re-open the retained sandbox by id and wake it. The workspace comes
        // from the retained disk, not from the spec.
        try {
          this.client = await this.factory.get(this.spec.adopt);
        } catch (error) {
          if (error instanceof DaytonaNotFoundError) {
            throw new Error(
              `retained daytona sandbox ${this.spec.adopt} is gone`,
            );
          }
          throw error;
        }
        this._id = this.client.id;
        await this.client.start(START_TIMEOUT_SECS);
        await this.adoptWorkspace();

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
        this.client = await this.factory.create(
          this.createParams(),
          { timeout: START_TIMEOUT_SECS },
        );
        created = true;
        this._id = this.client.id;
        // `create()` can hand back a sandbox that is not yet exec-ready; this
        // is a no-op (a single short request) when it already started.
        await this.client.start(START_TIMEOUT_SECS);
        await this.adoptWorkspace();
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
        await this.client.delete(120, true).catch(() => undefined);
      }
      throw error;
    }
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertUsable();
    // Daytona has no detached-job primitive this adapter can poll, so a
    // `backgroundAfterSecs` request simply runs normally (the contract allows
    // a backend without jobs to ignore it).
    return this.execRaw(command, opts);
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

  async fork(_ref?: string): Promise<Sandbox> {
    this.assertUsable();
    throw new Error(
      "fork() is not supported by the daytona backend: the API rejects forking of container-class " +
        'sandboxes (422 "Forking is not supported for this sandbox"), so the provider declares fork: false',
    );
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const client = this.client;
    if (!client) return;

    // `keep` is the debugging switch: leave it running for a human to inspect.
    if (this.spec.keep) {
      if (!this.opts.quiet) {
        process.stderr.write(
          `keeping daytona sandbox for debugging: ${this._id}\n`,
        );
      }
      return;
    }

    // `retain` is thread continuity: stop (not delete) so the next run can
    // adopt it with the workspace intact, without paying for a running VM.
    if (this.spec.retain) {
      await client.stop(120).catch((error) => {
        if (!(error instanceof DaytonaNotFoundError) && !this.opts.quiet) {
          process.stderr.write(
            `could not stop daytona sandbox ${this._id}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      });
      if (!this.opts.quiet) {
        process.stderr.write(
          `retained daytona sandbox for thread continuation: ${this._id}\n`,
        );
      }
      return;
    }

    await client.delete(120, true).catch((error) => {
      // Already gone is not an error; a transport failure is worth reporting
      // but must not turn cleanup into a run-ending throw.
      if (!(error instanceof DaytonaNotFoundError) && !this.opts.quiet) {
        process.stderr.write(
          `could not delete daytona sandbox ${this._id}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    });
  }

  // --- internals -----------------------------------------------------------

  private assertUsable(): void {
    if (!this.started) {
      throw new Error(`sandbox ${this._id} not started — call start() first`);
    }
    if (this.destroyed) {
      throw new Error(`sandbox ${this._id} was destroyed`);
    }
  }

  /**
   * Resolve the workspace from the sandbox's own home directory: a fresh
   * Daytona sandbox's home differs by image (`/home/daytona` on the default
   * snapshot, `/root` on a bare `ubuntu` build), and hard-coding one would put
   * the clone in a directory the sandbox user cannot write.
   */
  private async adoptWorkspace(): Promise<void> {
    if (this.spec.workspacePath || this.opts.cwd !== undefined) return;
    const home = await this.client?.getUserHomeDir?.().catch(() => undefined);
    if (home && home.trim() !== "") this._workspace = `${home.replace(/\/$/, "")}/repo`;
  }

  /** The create() payload: image, resources, env, and lifecycle windows. */
  private createParams(): Record<string, unknown> {
    const params: Record<string, unknown> = {
      ...(this.spec.env ? { envVars: this.spec.env } : {}),
      ...(this.opts.user ? { user: this.opts.user } : {}),
      autoStopInterval:
        this.opts.autoStopInterval ?? DEFAULT_AUTO_STOP_MINUTES,
      ...(this.opts.autoArchiveInterval !== undefined
        ? { autoArchiveInterval: this.opts.autoArchiveInterval }
        : {}),
      ...(this.opts.autoDeleteInterval !== undefined
        ? { autoDeleteInterval: this.opts.autoDeleteInterval }
        : {}),
    };
    // `spec.image` wins, then the provider's snapshot, then Daytona's default.
    if (this.spec.image) params.image = this.spec.image;
    else if (this.opts.snapshot) params.snapshot = this.opts.snapshot;
    return params;
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
      const init = await this.execRaw(
        `git init -q -b main ${shq(workspace)}`,
        { cwd: "/", timeoutSecs: 120 },
      );
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
        `sandbox ${this._id} has no Daytona client — call start() first`,
      );
    }

    const timeoutSecs = clampTimeout(opts.timeoutSecs);
    const cwd = opts.cwd ?? this._workspace;
    const env = {
      ...this.spec.env,
      ...(await this.gitEnv()),
      ...opts.env,
    };
    const startedAt = Date.now();
    // One short-lived session per call: self-contained (no state leaks between
    // execs) and safe to overlap.
    const sessionId = `anchor-${++this.sessionSeq}-${Date.now().toString(36)}`;

    try {
      await client.process.createSession(sessionId);
      try {
        const result = await client.process.executeSessionCommand(
          sessionId,
          { command: daytonaCommand(command, cwd, timeoutSecs, env) },
          // The guest-side `timeout` is the real kill; this is only a slightly
          // longer transport guard so a wedged RPC cannot hang the run.
          timeoutSecs + 30,
        );
        return daytonaResult(result, startedAt);
      } finally {
        await client.process.deleteSession(sessionId).catch(() => undefined);
      }
    } catch (error) {
      return daytonaTransportFailure(
        error instanceof Error ? error.message : String(error),
        startedAt,
      );
    }
  }
}

/** Daytona cloud sandboxes as a provider. */
export function daytona(opts: DaytonaSandboxOptions = {}): SandboxProvider {
  return {
    name: "daytona",
    // One source of truth: the exported declaration, so a consumer reading
    // `daytonaCapabilities` and a provider's `capabilities` cannot disagree.
    capabilities: daytonaCapabilities,
    create: (spec) => new DaytonaSandbox(spec, opts),
    adopt: (handle, spec = {}) =>
      new DaytonaSandbox({ ...spec, adopt: handle.id }, opts),
    release: async (handle) => {
      try {
        const sandbox = await new Daytona(configOf(opts)).get(handle.id);
        await sandbox.delete(120, true);
      } catch (error) {
        // Already-gone is not an error; a transport failure is reported but
        // must not turn release into a throw the caller has to handle.
        if (!(error instanceof DaytonaNotFoundError) && !opts.quiet) {
          process.stderr.write(
            `could not release daytona sandbox ${handle.id}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    },
    probe: async (): Promise<ProviderHealth> => {
      try {
        const first = await new Daytona(configOf(opts)).list({ limit: 1 }).next();
        return {
          ok: true,
          name: "daytona",
          detail: first.done
            ? "authenticated; no sandboxes yet"
            : "authenticated; sandboxes listed",
        };
      } catch (error) {
        return {
          ok: false,
          name: "daytona",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
