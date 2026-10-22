/**
 * DaytonaSandbox — the `Sandbox` interface on Daytona cloud sandboxes.
 *
 * Daytona is a remote VM provider with the primitives this contract needs:
 * create from an image, get/start (resume), pause, delete, copy-on-write
 * fork, and per-command timeouts. The adapter maps those onto the same
 * lifecycle as `local`, `docker`, `heyo`, and `e2b`; everything above the
 * sandbox (engine, tools, traces) stays provider-agnostic.
 *
 * `SandboxSpec.image` is interpreted as a **registry Docker image** — unlike
 * E2B, Daytona builds a snapshot from the image at create time, so any image
 * with bash, git, and coreutils (including `timeout`) works. `image` is the
 * factory default when a spec names none.
 *
 * The timeout rule is the repo-wide one: Daytona's `executeCommand` timeout is
 * a control-plane deadline, so every command is wrapped in guest-side
 * `timeout -k` and exit 124/137 is reported as `timedOut`.
 */
import {
  Daytona,
  DaytonaNotFoundError,
  Image,
  Sandbox as DaytonaSandboxClient,
  type DaytonaConfig,
  type Resources,
} from "@daytona/sdk";
import type {
  ImageBuildResult,
  ImageBuildSpec,
  ProviderHealth,
  SandboxProvider,
} from "../provider.js";
import {
  clampTimeout,
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
} from "./exec.js";

/** Default workspace for a repo cloned by this adapter. */
const DEFAULT_WORKSPACE = "/workspace/repo";
/** Lifecycle-scoped scratch, outside the repo (spills, notes). */
const DEFAULT_SCRATCH = "/tmp/anchor";
/** Reuse a minted git token for this long (installation tokens live for hours). */
const GIT_TOKEN_TTL_MS = 5 * 60_000;
/** Create/pause/start/delete wait, in seconds (Daytona default is 60). */
const DEFAULT_OP_TIMEOUT_SECS = 120;

export interface DaytonaSandboxOptions {
  /** Daytona API key. Omit to let the SDK read `DAYTONA_API_KEY`. */
  apiKey?: string;
  /** Daytona API URL (self-hosted control planes). Omit for the default cloud. */
  apiUrl?: string;
  /**
   * Default region for sandboxes (e.g. "us"). Omit for the org default.
   */
  target?: string;
  /**
   * Default Docker image for sandboxes whose spec names none. Must contain
   * `bash`, `git`, and coreutils including `timeout`.
   */
  image?: string;
  /** Resource allocation when the spec names none (cpu/memory/disk in GiB). */
  resources?: Resources;
  /** Default workspace path when the spec names none. */
  cwd?: string;
  /** Scratch directory inside the sandbox (default `/tmp/anchor`). */
  scratch?: string;
  /** Silence lifecycle notes (tests). */
  quiet?: boolean;
  /**
   * Test seam: the network entry points. Defaults to the Daytona SDK, so a
   * unit test can exercise start/adopt/destroy without an account.
   */
  clientFactory?: DaytonaClientFactory;
}

/**
 * The create/get pair, injectable so the adapter is testable offline. The
 * returned object needs only the surface this adapter touches: `id`,
 * `state`, `labels`, `process.executeCommand`, `start`, `pause`, `delete`,
 * `fork`, and `refreshData` (called by the SDK's own wait helpers).
 */
export interface DaytonaClientFactory {
  create(
    image: string | undefined,
    opts: {
      envVars?: Record<string, string>;
      labels?: Record<string, string>;
      resources?: Resources;
      /** Boot from a named snapshot (a `buildImage` name) instead of an image. */
      snapshot?: string;
    },
  ): Promise<DaytonaSandboxClient>;
  get(idOrName: string): Promise<DaytonaSandboxClient>;
  /**
   * Build and register a named snapshot from an Image definition — the
   * publish half of `buildImage`. Returns the registered snapshot's name.
   */
  createSnapshot(
    name: string,
    image: Image,
    opts?: { cpu?: number; memoryMB?: number; disk?: number },
  ): Promise<string>;
  /**
   * Does a snapshot with this name exist? `buildImage` names are snapshots;
   * `spec.image` is an opaque string, so start() resolves it this way.
   */
  snapshotExists(name: string): Promise<boolean>;
}

/**
 * The real factory: one Daytona client per provider, cached. A `Sandbox`
 * shares the client's event subscription manager, so a fresh-per-call client
 * that gets disposed would break the sandbox's state waits — cache instead.
 */
function defaultFactory(opts: DaytonaSandboxOptions): DaytonaClientFactory {
  let client: Daytona | undefined;
  const daytona = (): Daytona =>
    (client ??= new Daytona({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
      ...(opts.target ? { target: opts.target } : {}),
    }));
  return {
    create: async (image, createOpts) =>
      daytona().create(
        {
          // A named snapshot wins: it is the published `buildImage` result.
          ...(createOpts.snapshot
            ? { snapshot: createOpts.snapshot }
            : image
              ? { image }
              : {}),
          ...(createOpts.envVars ? { envVars: createOpts.envVars } : {}),
          ...(createOpts.labels ? { labels: createOpts.labels } : {}),
          ...(createOpts.resources
            ? { resources: createOpts.resources }
            : {}),
          // Continuity over auto-lifecycle: a retained sandbox must never be
          // reaped by an idle timer while its thread is between runs, and a
          // run-long command must not pause under the agent. Retention is
          // handled explicitly at destroy() (pause) and release().
          autoStopInterval: 0,
          autoPauseInterval: 0,
          autoDeleteInterval: -1,
          autoArchiveInterval: 0,
        },
        { timeout: DEFAULT_OP_TIMEOUT_SECS },
      ),
    createSnapshot: async (name, image, resources) => {
      // Publish-then-boot: `snapshot.create` builds and registers the image
      // once; later `create({ snapshot: name })` boots from it without paying
      // the build again.
      const snapshot = await daytona().snapshot.create(
        {
          name,
          image,
          ...(resources?.cpu || resources?.memoryMB || resources?.disk
            ? {
                resources: {
                  ...(resources.cpu ? { cpu: resources.cpu } : {}),
                  ...(resources.memoryMB
                    ? { memory: resources.memoryMB }
                    : {}),
                  ...(resources.disk ? { disk: resources.disk } : {}),
                },
              }
            : {}),
        },
        { timeout: 0 },
      );
      if (
        snapshot.state === "error" ||
        snapshot.state === "build_failed"
      ) {
        throw new Error(
          `daytona snapshot build failed: ${snapshot.name} (${snapshot.state})` +
            `${snapshot.errorReason ? ` — ${snapshot.errorReason}` : ""}`,
        );
      }
      return snapshot.name;
    },
    snapshotExists: async (name) => {
      try {
        await daytona().snapshot.get(name);
        return true;
      } catch {
        return false;
      }
    },
    get: async (idOrName) => {
      const sandbox = await daytona().get(idOrName);
      // A paused (retained) sandbox must be woken before commands can run;
      // `start()` on an already-started sandbox is a no-op server-side.
      await sandbox.start(DEFAULT_OP_TIMEOUT_SECS);
      return sandbox;
    },
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

  constructor(
    private readonly spec: SandboxSpec,
    private readonly opts: DaytonaSandboxOptions = {},
  ) {
    this._id = spec.adopt ?? "pending";
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
        "the daytona backend has no egress control wired yet — it declares egressControl: false",
      );
    }
    let created = false;

    try {
      if (this.spec.adopt) {
        // Wake the retained sandbox. `get` resumes a paused one; the
        // workspace comes from the retained disk, not from the spec.
        this.client = await this.factory.get(this.spec.adopt);
        this._id = this.client.id;
        this.applyMetadata(this.client);

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
        const image = this.spec.image ?? this.opts.image;
        if (!image) {
          throw new Error(
            "no image for the daytona sandbox — pass image to daytona() or spec.image " +
              "(a registry Docker image with bash, git, and coreutils)",
          );
        }
        // `spec.image` is opaque: a `buildImage` name is a registered
        // snapshot; anything else is a registry image. One lookup routes it.
        const snapshot = (await this.factory.snapshotExists(image))
          ? image
          : undefined;
        this.client = await this.factory.create(snapshot ?? image, {
          ...(snapshot ? { snapshot } : {}),
          ...(this.spec.env ? { envVars: this.spec.env } : {}),
          // Store the coordinates on the sandbox so an adoption does not have
          // to guess them from the caller's sources.
          labels: {
            anchorWorkspace: b64(this._workspace),
            anchorScratch: b64(this._scratch),
          },
          ...(this.opts.resources ? { resources: this.opts.resources } : {}),
        });
        created = true;
        this._id = this.client.id;
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
        await this.client.delete().catch(() => undefined);
      }
      throw error;
    }
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertUsable();
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

  async fork(ref?: string): Promise<Sandbox> {
    this.assertUsable();
    // Daytona's fork is copy-on-write on the CURRENT state (including
    // uncommitted work). Anchor's fork contract is a CLEAN checkpoint state,
    // so reset the tracked tree and drop untracked files after attaching.
    // `.anchor/` is git-excluded, so it survives `git clean -fd`.
    const forked = await this.client!.fork(
      undefined,
      DEFAULT_OP_TIMEOUT_SECS,
    );
    const child = new DaytonaSandbox(
      { ...this.spec, adopt: forked.id, workspacePath: this._workspace },
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
    const client = this.client;
    if (!client) return;

    // `keep` is the debugging switch: leave it running for a human to inspect
    // (the sandbox's own auto-stop is disabled at create; a human deletes it).
    if (this.spec.keep) {
      if (!this.opts.quiet) {
        process.stderr.write(
          `keeping Daytona sandbox for debugging: ${this._id}\n`,
        );
      }
      return;
    }

    // `retain` is thread continuity: pause so the next run can adopt it with
    // the workspace (and memory) intact, without paying for a running VM.
    if (this.spec.retain) {
      await client.pause(DEFAULT_OP_TIMEOUT_SECS).catch((error: unknown) => {
        if (!(error instanceof DaytonaNotFoundError) && !this.opts.quiet) {
          process.stderr.write(
            `could not pause Daytona sandbox ${this._id}: ${error instanceof Error ? error.message : String(error)}\n`,
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

    await client.delete().catch((error: unknown) => {
      // Already gone is not an error; a transport failure is worth reporting
      // but must not turn cleanup into a run-ending throw.
      if (!(error instanceof DaytonaNotFoundError) && !this.opts.quiet) {
        process.stderr.write(
          `could not delete Daytona sandbox ${this._id}: ${error instanceof Error ? error.message : String(error)}\n`,
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

  /** Read the coordinates stored at create time; an explicit option wins. */
  private applyMetadata(client: {
    labels?: Record<string, string>;
  }): void {
    if (!this.spec.workspacePath) {
      const workspace = unb64(client.labels?.["anchorWorkspace"]);
      if (workspace) this._workspace = workspace;
    }
    if (this.opts.scratch === undefined) {
      const scratch = unb64(client.labels?.["anchorScratch"]);
      if (scratch) this._scratch = scratch;
    }
  }

  /** Attach to an already-resolved Daytona sandbox (the fork path). */
  private async attach(client: DaytonaSandboxClient): Promise<void> {
    this.client = client;
    this._id = client.id;
    this.applyMetadata(client);
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
        throw new Error(`workspacePath ${workspace} does not exist in the sandbox`);
      }
      // configureGit() runs in the workspace right after this; fail with the
      // path named rather than with a bare "git config failed".
      const git = await this.execRaw(
        `test -d ${shq(`${workspace}/.git`)}`,
        { cwd: "/", timeoutSecs: 60 },
      );
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
        throw new Error(`git clone failed: ${clone.output.trim().slice(0, 500)}`);
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
      shell: async (command, opts) =>
        this.execRaw(command, {
          timeoutSecs: opts?.timeoutSecs ?? 120,
        }),
    };
  }

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
    const envs = {
      ...this.spec.env,
      ...(await this.gitEnv()),
      ...opts.env,
    };
    const startedAt = Date.now();

    try {
      const result = await client.process.executeCommand(
        daytonaCommand(command, cwd, timeoutSecs),
        "/",
        envs,
        // The guest-side `timeout` is the real kill; this is only a slightly
        // longer transport guard so a wedged RPC cannot hang the run.
        timeoutSecs + 30,
      );
      return daytonaResult(result, startedAt);
    } catch (error) {
      // executeCommand resolves with the exit code instead of throwing on
      // non-zero exits; a throw here is a genuine transport/API failure and
      // the command's completion is unknown.
      return daytonaTransportFailure(
        error instanceof Error ? error.message : String(error),
        startedAt,
      );
    }
  }
}

/** Encode a path for a label value (label validators are unknown; b64 is safe). */
function b64(path: string): string {
  return Buffer.from(path, "utf8").toString("base64");
}

/** Decode a stored path label; empty/missing returns undefined. */
function unb64(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return decoded.startsWith("/") ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Daytona cloud sandboxes as a provider. */
export function daytona(opts: DaytonaSandboxOptions = {}): SandboxProvider {
  const connectionOpts = (): DaytonaConfig => ({
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.target ? { target: opts.target } : {}),
  });
  return {
    name: "daytona",
    capabilities: {
      fork: true, // native copy-on-write `sandbox.fork()`
      retain: true, // pause / get+start
      remoteCheckpoint: true, // git push over the sandbox's network
      egressControl: false, // not wired by this adapter yet
      localPath: false, // remote VM; no host-directory import
      buildImage: true, // daytona.snapshot.create publishes a named snapshot
    },
    create: (spec) => new DaytonaSandbox(spec, opts),
    buildImage: async (spec): Promise<ImageBuildResult> => {
      if (!spec.fromImage && !spec.dockerfile) {
        throw new Error(
          "daytona buildImage: name exactly one of fromImage / dockerfile",
        );
      }
      if (spec.fromImage && spec.dockerfile) {
        throw new Error(
          "daytona buildImage: fromImage and dockerfile are mutually exclusive",
        );
      }
      // `Image.fromDockerfile(path)` reads host-side; `Image.base(ref)` is the
      // registry pull. `run[]` layers `RUN` steps onto either.
      const image = spec.dockerfile
        ? Image.fromDockerfile(spec.dockerfile)
        : Image.base(spec.fromImage!);
      if (spec.run?.length) image.runCommands(...spec.run);
      const factory = opts.clientFactory ?? defaultFactory(opts);
      const name = await factory.createSnapshot(spec.name, image, {
        cpu: spec.cpu,
        memoryMB: spec.memoryMB,
      });
      return { name, provider: "daytona" };
    },
    adopt: (handle, spec = {}) =>
      new DaytonaSandbox({ ...spec, adopt: handle.id }, opts),
    release: async (handle) => {
      let sandbox: DaytonaSandboxClient | undefined;
      try {
        const daytona = new Daytona(connectionOpts());
        sandbox = await daytona.get(handle.id);
        await sandbox.delete(DEFAULT_OP_TIMEOUT_SECS);
      } catch (error) {
        // Already-gone is not an error; a transport failure is reported but
        // must not turn release into a throw the caller has to handle.
        if (!(error instanceof DaytonaNotFoundError) && !opts.quiet) {
          process.stderr.write(
            `could not release Daytona sandbox ${handle.id}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    },
    probe: async (): Promise<ProviderHealth> => {
      try {
        const client = new Daytona(connectionOpts());
        try {
          // A one-page listing is the cheapest authenticated reachability
          // check the Daytona API offers.
          const iterator = client.list();
          const page = await iterator.next();
          return {
            ok: true,
            name: "daytona",
            detail: `image ${opts.image ?? "spec-provided"}${page.done ? "" : " (account reachable)"}`,
          };
        } finally {
          await client[Symbol.asyncDispose]().catch(() => undefined);
        }
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
