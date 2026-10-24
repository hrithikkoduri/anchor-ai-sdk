/**
 * DaytonaSandbox — the `Sandbox` interface on Daytona cloud sandboxes.
 *
 * Daytona is a remote VM provider whose primitives line up with this contract
 * almost one-for-one: create/get, start/stop (disk survives), delete, fork,
 * preview links, and network controls that can be flipped while the sandbox
 * runs. Everything above the sandbox (engine, tools, traces) stays
 * provider-agnostic.
 *
 * Two Daytona-specific facts shape this adapter:
 *
 *   - **`SandboxSpec.image` is a Docker image name**, which Daytona accepts at
 *     create time (unlike E2B, which needs a prebuilt template). `snapshot`
 *     pins a named snapshot instead; the two are mutually exclusive.
 *   - **The toolbox executes a session command with no `cwd`/`env`**, so every
 *     command is wrapped once (`daytonaCommand`) with its working directory,
 *     env, and a guest-side `timeout -k`. The per-call API `timeout` is only a
 *     request deadline — it is not proof the guest process died.
 *
 * Exec runs in a long-lived toolbox *session* rather than one-shot
 * `executeCommand`, because the session API returns stdout and stderr
 * separately. `ExecResult` promises both, and the conformance suite checks it.
 */
import type { ProviderHealth, SandboxProvider } from "../provider.js";
import {
  clampTimeout,
  shq,
  type Checkpoint,
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  type SandboxSpec,
  type PreviewEndpoint,
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
} from "./exec.js";

/** Default workspace for a repo cloned by this adapter. */
const DEFAULT_WORKSPACE = "/home/user/repo";
/** Lifecycle-scoped scratch, outside the repo (spills, notes). */
const DEFAULT_SCRATCH = "/tmp/anchor";
/** The toolbox session every exec reuses (created lazily in start()). */
const EXEC_SESSION = "anchor";
/** Lifecycle operation deadline (create/start/delete/fork), in seconds. */
const DEFAULT_LIFECYCLE_TIMEOUT_SECS = 300;
/** Reuse a minted git token for this long (installation tokens live for hours). */
const GIT_TOKEN_TTL_MS = 5 * 60_000;

/**
 * The slice of a Daytona sandbox this adapter uses. Narrow on purpose: the
 * adapter depends on behavior, not on the SDK's full surface, and a unit test
 * can supply one of these without an account.
 */
export interface DaytonaSandboxHandle {
  /** Sandbox id (stable across start/stop). */
  id: string;
  /** Current state, e.g. "started" / "stopped" (absent on a minimal fake). */
  state?: string;
  process: {
    createSession(sessionId: string): Promise<void>;
    executeSessionCommand(
      sessionId: string,
      req: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
      timeout?: number,
    ): Promise<{
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      output?: string;
    }>;
  };
  /** Wake a stopped sandbox; the disk (and workspace) is already there. */
  start(timeout?: number): Promise<void>;
  /** Stop without deleting — disk survives, so a later adopt finds the work. */
  stop(): Promise<void>;
  delete(timeout?: number, wait?: boolean): Promise<void>;
  fork?(params?: { name?: string }, timeout?: number): Promise<DaytonaSandboxHandle>;
  getPreviewLink(port: number): Promise<{ url: string; token: string }>;
  updateNetworkSettings(settings: {
    networkBlockAll?: boolean;
    networkAllowList?: string;
    domainAllowList?: string;
  }): Promise<void>;
  getUserHomeDir?(): Promise<string | undefined>;
}

/** Creation parameters this adapter passes through to Daytona. */
export interface DaytonaCreateParams {
  image?: string;
  snapshot?: string;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  user?: string;
  resources?: { cpu?: number; memory?: number; disk?: number; gpu?: number };
  autoStopInterval?: number;
  autoPauseInterval?: number;
  networkBlockAll?: boolean;
  public?: boolean;
}

/**
 * The network entry points, injectable so the adapter is testable offline.
 * Defaults to the Daytona SDK (`@daytona/sdk`), loaded only through this
 * subpath.
 */
export interface DaytonaClient {
  create(
    params: DaytonaCreateParams,
    options?: { timeout?: number },
  ): Promise<DaytonaSandboxHandle>;
  get(id: string): Promise<DaytonaSandboxHandle>;
  /** Optional: `probe()` uses it. Absent means "cannot be probed cheaply". */
  list?(query?: { limit?: number }): AsyncIterableIterator<unknown>;
}

export interface DaytonaSandboxOptions {
  /** Daytona API key. Omit to let the SDK read `DAYTONA_API_KEY`. */
  apiKey?: string;
  /** Control-plane URL (self-hosted Daytona, or a region endpoint). */
  apiUrl?: string;
  /** Default target region for sandboxes and snapshots. */
  target?: string;
  /** Default Docker image for sandboxes whose spec names none. */
  image?: string;
  /** Default snapshot for sandboxes whose spec names none (wins over image). */
  snapshot?: string;
  /** User commands run as (the snapshot's default when omitted). */
  user?: string;
  /** Default resources (cpu cores, memory GiB, disk GiB). */
  resources?: DaytonaCreateParams["resources"];
  /** Default workspace path when the spec names none. */
  cwd?: string;
  /** Scratch directory inside the sandbox (default `/tmp/anchor`). */
  scratch?: string;
  /** Lifecycle operation deadline in seconds (create/start/delete/fork). */
  lifecycleTimeoutSecs?: number;
  /** Silence lifecycle notes (tests). */
  quiet?: boolean;
  /** Test seam: the network entry points. Defaults to the Daytona SDK. */
  clientFactory?: () => Promise<DaytonaClient> | DaytonaClient;
}

export class DaytonaSandbox implements Sandbox {
  readonly backend = "daytona" as const;

  private _id: string;
  private _workspace: string;
  private _scratch: string;
  private handle?: DaytonaSandboxHandle;
  private started = false;
  private destroyed = false;
  private sessionReady = false;
  private readonly factory: () => Promise<DaytonaClient>;
  /** Git tokens are installation tokens (hours); cache one briefly. */
  private gitToken?: { value: string; at: number };

  constructor(
    private readonly spec: SandboxSpec,
    private readonly opts: DaytonaSandboxOptions = {},
  ) {
    this._id = spec.adopt ?? "pending";
    this._workspace = spec.workspacePath ?? opts.cwd ?? DEFAULT_WORKSPACE;
    this._scratch = opts.scratch ?? DEFAULT_SCRATCH;
    this.factory = memoized(() => resolveClient(opts));
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
    const client = await this.factory();
    let created = false;

    try {
      if (this.spec.adopt) {
        // The workspace comes from the retained disk, not from the spec.
        this.handle = await client.get(this.spec.adopt);
        this._id = this.handle.id;
        if (this.handle.state === "stopped") {
          await this.handle.start(this.lifecycleTimeoutSecs());
        }
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
        this.handle = await client.create(this.createParams(), {
          timeout: this.lifecycleTimeoutSecs(),
        });
        created = true;
        this._id = this.handle.id;
        await this.prepareWorkspace();
      }

      await this.ensureSession();
      await this.configureGit();
      // The reserved .anchor dir: git-excluded (status/diff), checkpoint-carried.
      await this.execRaw(reservedScratchPrepCommand(), { timeoutSecs: 60 });

      // Egress: setup needed the network; the AGENT phase gets cut off here.
      // Declared as `egressControl: true`, so this is enforced, not promised.
      if (this.spec.egress === "none") {
        await this.handle.updateNetworkSettings({ networkBlockAll: true });
      }

      this.started = true;
    } catch (error) {
      // A failed start must not leak the sandbox it just created. An adopted
      // sandbox is not ours to kill — it belongs to its owner.
      if (created && this.handle) {
        await this.handle.delete(0).catch(() => undefined);
      }
      throw error;
    }
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertUsable();
    return this.execRaw(command, opts);
  }

  /**
   * Port preview. Daytona returns a URL plus an access token; Anchor does not
   * add or remove an auth layer, so the token is appended as the query
   * parameter Daytona's own docs use, keeping the bare URL useful for a
   * public sandbox.
   */
  async exposePort(port: number): Promise<PreviewEndpoint> {
    this.assertUsable();
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`port must be an integer in 1..65535, got ${port}`);
    }
    const preview = await this.handle!.getPreviewLink(port);
    return { url: previewUrl(preview), port };
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
    if (!this.handle!.fork) {
      throw new Error("this Daytona client cannot fork sandboxes");
    }
    // Daytona forks the current filesystem, uncommitted work included. The
    // contract's fork is a CLEAN checkpoint state, so reset the tracked tree
    // and drop untracked files after attaching (`.anchor/` is git-excluded, so
    // it survives `git clean -fd`).
    const forked = await this.handle!.fork({}, this.lifecycleTimeoutSecs());
    const child = new DaytonaSandbox(
      {
        ...this.spec,
        adopt: forked.id,
        workspacePath: this._workspace,
        egress: this.spec.egress,
      },
      this.opts,
    );
    await child.attach(forked);

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
    const handle = this.handle;
    if (!handle) return;

    // `keep` is the debugging switch: leave it running for a human to inspect.
    if (this.spec.keep) {
      if (!this.opts.quiet) {
        process.stderr.write(`keeping Daytona sandbox for debugging: ${this._id}\n`);
      }
      return;
    }

    // `retain` is thread continuity: STOP, do not delete. The disk (and the
    // workspace) survives, and the next run adopts it by id.
    if (this.spec.retain) {
      await handle.stop().catch((error: unknown) => {
        if (!this.opts.quiet) {
          process.stderr.write(
            `could not stop Daytona sandbox ${this._id}: ${message(error)}\n`,
          );
        }
      });
      if (!this.opts.quiet) {
        process.stderr.write(
          `retained Daytona sandbox for thread continuation: ${this._id}\n`,
        );
      }
      return;
    }

    await handle.delete(0).catch((error: unknown) => {
      // Already gone is not an error; anything else is worth reporting but
      // must not turn cleanup into a run-ending throw.
      if (!isNotFound(error) && !this.opts.quiet) {
        process.stderr.write(
          `could not delete Daytona sandbox ${this._id}: ${message(error)}\n`,
        );
      }
    });
  }

  // --- internals -----------------------------------------------------------

  private lifecycleTimeoutSecs(): number {
    return this.opts.lifecycleTimeoutSecs ?? DEFAULT_LIFECYCLE_TIMEOUT_SECS;
  }

  private assertUsable(): void {
    if (!this.started) {
      throw new Error(`sandbox ${this._id} not started — call start() first`);
    }
    if (this.destroyed) {
      throw new Error(`sandbox ${this._id} was destroyed`);
    }
  }

  /** Create parameters for a fresh sandbox; defined options win over defaults. */
  private createParams(): DaytonaCreateParams {
    const image = this.spec.image ?? this.opts.image;
    const snapshot = this.opts.snapshot;
    return {
      ...(snapshot ? { snapshot } : image ? { image } : {}),
      ...(this.spec.env ? { envVars: this.spec.env } : {}),
      ...(this.opts.user ? { user: this.opts.user } : {}),
      ...(this.opts.resources ? { resources: this.opts.resources } : {}),
      // Coordinates on the sandbox itself, so an adoption from a fresh process
      // (a preview opened from a fresh process) need not guess them.
      labels: {
        anchorWorkspace: this._workspace,
        anchorScratch: this._scratch,
      },
    };
  }

  /** Attach to an already-connected Daytona sandbox (the fork path). */
  private async attach(handle: DaytonaSandboxHandle): Promise<void> {
    this.handle = handle;
    this._id = handle.id;
    await this.ensureSession();
    this.started = true;
  }

  /** Create the long-lived exec session once (idempotent across adopt/fork). */
  private async ensureSession(): Promise<void> {
    if (this.sessionReady || !this.handle) return;
    await this.handle.process.createSession(EXEC_SESSION);
    this.sessionReady = true;
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
    const hasGit = await this.execRaw(
      `test -d ${shq(`${workspace}/.git`)}`,
      { cwd: "/", timeoutSecs: 60 },
    );
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
    const handle = this.handle;
    if (!handle) {
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

    try {
      const result = await handle.process.executeSessionCommand(
        EXEC_SESSION,
        {
          command: daytonaCommand(command, cwd, timeoutSecs, env),
          // Synchronous: the response carries stdout, stderr, and the exit
          // code together. A detached job is a separate feature this adapter
          // does not claim (no pollJob/killJob).
          runAsync: false,
          suppressInputEcho: true,
        },
        // The guest-side `timeout` is the real kill; this is only a slightly
        // longer transport guard so a wedged RPC cannot hang the run.
        timeoutSecs + 30,
      );
      return daytonaResult(result, startedAt);
    } catch (error) {
      // A thrown toolbox call is a TRANSPORT failure: the command may or may
      // not have run. It is never replayed here — the caller decides.
      return daytonaTransportFailure(message(error), startedAt);
    }
  }
}

/** Daytona cloud sandboxes as a provider. */
export function daytona(opts: DaytonaSandboxOptions = {}): SandboxProvider {
  const client = memoized(() => resolveClient(opts));
  return {
    name: "daytona",
    capabilities: {
      fork: true, // native sandbox fork (identical filesystem)
      retain: true, // stop keeps the disk; adopt by id wakes it
      remoteCheckpoint: true, // git push over the sandbox's network
      egressControl: true, // updateNetworkSettings({ networkBlockAll })
      localPath: false, // remote VM; no host-directory import
      previewPort: true, // getPreviewLink(port)
      // processStream: the toolbox exposes async session commands, but this
      // adapter does not stream them yet. Declared false rather than promised.
      // Background jobs (pollJob/killJob) are likewise unimplemented.
      processStream: false,
    },
    create: (spec) => new DaytonaSandbox(spec, opts),
    adopt: (handle, spec = {}) =>
      new DaytonaSandbox({ ...spec, adopt: handle.id }, opts),
    release: async (handle) => {
      try {
        const sandbox = await (await client()).get(handle.id);
        await sandbox.delete(0);
      } catch (error) {
        // Already-gone is not an error; a transport failure is reported but
        // must not turn release into a throw the caller has to handle.
        if (!isNotFound(error) && !opts.quiet) {
          process.stderr.write(
            `could not release Daytona sandbox ${handle.id}: ${message(error)}\n`,
          );
        }
      }
    },
    probe: async (): Promise<ProviderHealth> => {
      try {
        const daytonaClient = await client();
        if (!daytonaClient.list) {
          return {
            ok: false,
            name: "daytona",
            detail: "this client cannot list sandboxes (probe unavailable)",
          };
        }
        // One cheap authenticated call proves credentials and reachability.
        for await (const _ of daytonaClient.list({ limit: 1 })) break;
        return {
          ok: true,
          name: "daytona",
          detail: opts.snapshot
            ? `snapshot ${opts.snapshot}`
            : `image ${opts.image ?? "default"}`,
        };
      } catch (error) {
        return { ok: false, name: "daytona", detail: message(error) };
      }
    },
  };
}

/** Memoize one promise: the client is created on first use, never eagerly. */
function memoized(
  create: () => Promise<DaytonaClient>,
): () => Promise<DaytonaClient> {
  let pending: Promise<DaytonaClient> | undefined;
  return () => {
    pending ??= create();
    return pending;
  };
}

/**
 * The network entry points for one sandbox: the injected factory when the
 * caller supplied one, otherwise the Daytona SDK. Lazy because a provider is
 * constructed at startup with no credentials in hand — `probe()` is what
 * decides whether they work.
 */
function resolveClient(opts: DaytonaSandboxOptions): Promise<DaytonaClient> {
  if (!opts.clientFactory) return defaultClient(opts);
  return Promise.resolve(opts.clientFactory());
}

async function defaultClient(
  opts: DaytonaSandboxOptions = {},
): Promise<DaytonaClient> {
  const { Daytona } = await import("@daytona/sdk");
  const client = new Daytona({
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.target ? { target: opts.target } : {}),
  });
  return client as unknown as DaytonaClient;
}

/** Preview URL: Daytona's own token convention, never an Anchor auth layer. */
function previewUrl(preview: { url: string; token: string }): string {
  if (!preview.token) return preview.url;
  const separator = preview.url.includes("?") ? "&" : "?";
  return `${preview.url}${separator}daytona-preview-token=${encodeURIComponent(preview.token)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A deleted sandbox surfaces as a 404-shaped error across Daytona SDKs. */
function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { statusCode?: number; code?: string; message?: string };
  if (candidate.statusCode === 404) return true;
  if (candidate.code === "NOT_FOUND") return true;
  return /not found/i.test(candidate.message ?? "");
}
