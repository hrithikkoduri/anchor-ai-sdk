/**
 * HeyoSandbox — the `Sandbox` interface on real Firecracker microVMs via
 * Heyo Cloud (`@heyocomputer/hws`).
 *
 * Everything Heyo-specific lives in this file:
 *   - deployment lifecycle: create → pull image → boot → destroy (or keep)
 *   - the guest-side `timeout` wrapper: Heyo's API timeout does NOT kill the
 *     guest process, so every command is wrapped in coreutils `timeout`
 *   - credential plumbing: secrets arrive as env vars; git credentials live in
 *     /etc/git-credentials — never inside /workspace
 *   - checkpoints are plain git commits, like the local backend
 *
 * The names: a "deployment" in Heyo's API *is* our sandbox (routes: [] means
 * private — reached only through exec; no HTTP traffic).
 */
import { randomUUID } from "node:crypto";
import { Hws, type Shell } from "@heyocomputer/hws";
import { HeyoGuestExecutor } from "./exec.js";
import { upsertHeyoSecret } from "./secret.js";
import { ByteQueue } from "../process.js";
import { heyoImagePublisher } from "./image.js";
import type { ProviderHealth, SandboxProvider } from "../provider.js";
import {
  checkpointVia,
  hasChangesFromVia,
  reservedScratchPrepCommand,
  type GitAccess,
} from "../git.js";
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

/** VM size tiers (mirrors Heyo's size classes). */
export type HeyoSizeClass =
  | "micro"
  | "mini"
  | "small"
  | "medium"
  | "large"
  | "xlarge";

export interface HeyoSandboxConfig {
  token: string;
  server: string;
  namespace: string;
  /** VM image — heyo/bun:latest ships git + bun on Debian. */
  image: string;
  /**
   * How `image` resolves: a prebuilt artifact (default), or a Dockerfile
   * manifest (`heyvm.dockerfile.v1`) the host builds itself — the path for
   * our toolchain image, since heyvm builds are Linux-host-only.
   */
  imageKind?: "artifact" | "dockerfile" | "git";
  /** The artifact store both store kinds read from. Default: the public hub. */
  imageStore?: string;
  /** git kind: repo URL, ref, and Dockerfile path for host-side builds. */
  imageRepo?: string;
  imageRef?: string;
  imageDockerfile?: string;
  /** git kind: build context inside the repo (default: repo root). */
  imageContext?: string;
  /** git kind: an app-lb secret holding the git token (private repos). */
  imageAuth?: { secret: string; key?: string };
  /**
   * git-kind builds only: on `prepare()`, refresh the stored secret with a
   * fresh token — installation tokens expire, and the HOST build reads the
   * secret, not the spec.
   */
  buildSecretRefresh?: boolean;
  /**
   * Host-built images only: rootfs size in MB (`build.image_size_mb`). The
   * rootfs IS the kernel's root disk — its default (~1 GiB) fills up fast
   * when pip/venvs install into it; the /workspace data disk is `diskSizeGb`.
   */
  imageSizeMb?: number;
  /**
   * How long to wait for the deployment's pool to become healthy after an
   * image pull/build. Default 15 minutes: a first host-side build of a broad
   * toolchain image can outlive the old 5-minute budget.
   */
  readyTimeoutMs?: number;
  sizeClass: HeyoSizeClass;
  diskSizeGb: number;
  /**
   * Deprecated: prefer `SandboxSpec.git.token` (a callback — installation
   * tokens expire mid-run). Still honored for compatibility.
   */
  githubToken?: string;
}

/**
 * The exact command sent to the guest. Exported for tests: this wrapper is the
 * load-bearing half of the tool-call contract on Heyo — without it, a hung
 * `npm test` keeps burning a VM after the API call times out, and without the
 * embedded `cd`, commands silently run in `/` (Heyo starts every exec fresh
 * there — its `cwd` exec option is not dependable across server versions).
 */
export function buildGuestCommand(
  command: string,
  timeoutSecs: number,
  cwd: string,
): string {
  const inner = `cd ${shq(cwd)} && ${command}`;
  return `timeout -k 5 ${timeoutSecs} bash -c ${shq(inner)}`;
}

/** The host of an https repo URL — credentials apply there; ssh/other → undefined. */
function httpsHost(repoUrl: string | undefined): string | undefined {
  if (!repoUrl) return undefined;
  try {
    const url = new URL(repoUrl);
    return url.protocol === "https:" ? url.host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Live credential probe for `SandboxProvider.probe()` — never throws. Asks
 * whoami (the canonical check) and, best-effort, the deployment count; the
 * structured bits ride along in `info` for consumers like `doctor`.
 */
export async function probeHeyo(
  cfg: Pick<HeyoSandboxConfig, "server" | "token">,
): Promise<ProviderHealth> {
  const lb = new Hws({
    server: cfg.server,
    token: cfg.token,
    timeoutMs: 10_000,
  });
  try {
    const who = await lb.whoami();
    let deployments: number | undefined;
    try {
      deployments = (await lb.deployments()).length;
    } catch {
      deployments = undefined; // scope may exclude list rights; whoami is the check
    }
    const bits = [
      cfg.server,
      who.namespace ? `namespace ${who.namespace}` : "(unconfined)",
      `${who.admin_scope ?? "?"} tier`,
      ...(deployments !== undefined
        ? [`${deployments} deployment(s) alive`]
        : []),
    ];
    return {
      ok: true,
      name: "heyo",
      detail: bits.join(" · "),
      info: { namespace: who.namespace, admin: who.admin_scope, deployments },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      name: "heyo",
      detail: message.split("\n")[0] ?? message,
    };
  }
}

// Heyo admin machinery travels with the heyo subpath (it imports the SDK too).
export { upsertHeyoSecret } from "./secret.js";
export type { UpsertHeyoSecretArgs } from "./secret.js";

/** Heyo Cloud microVMs as a sandbox provider. */
export function heyo(cfg: HeyoSandboxConfig): SandboxProvider {
  return {
    name: "heyo",
    capabilities: {
      fork: false, // deferred: rebuild-from-checkpoint instead
      retain: true,
      remoteCheckpoint: true,
      egressControl: false,
      localPath: false, // the VM is another machine
      processStream: true,
      publishImage: true,
      previewPort: false,
    },
    imagePublisher: heyoImagePublisher({ imageStore: cfg.imageStore }),
    create: (spec) => new HeyoSandbox(spec, cfg),
    adopt: (handle, spec = {}) =>
      new HeyoSandbox({ ...spec, adopt: handle.id }, cfg),
    // Gone: a deployment the control plane no longer knows, or no workspace.
    // A wake that timed out is transient.
    isGone: (error) => error instanceof SandboxGoneError,
    release: async (handle) => {
      await new HeyoSandbox({ adopt: handle.id }, cfg).destroy();
    },
    prepare: async ({ gitToken } = {}) => {
      if (
        cfg.imageKind !== "git" ||
        !cfg.buildSecretRefresh ||
        !cfg.imageAuth?.secret ||
        !cfg.imageAuth.key ||
        !cfg.token ||
        !gitToken
      )
        return;
      await upsertHeyoSecret({
        server: cfg.server,
        token: cfg.token,
        namespace: cfg.namespace,
        secret: cfg.imageAuth.secret,
        key: cfg.imageAuth.key,
        value: await gitToken(),
      });
    },
    probe: () => probeHeyo(cfg),
  };
}

export class HeyoSandbox implements Sandbox {
  readonly backend = "heyo" as const;
  readonly id: string;
  /**
   * The repo path inside the VM. Defaults to the /workspace data disk; an
   * image-provisioned workspace can name its own path (SWE-bench images ship
   * the repo at /testbed), in which case start() verifies it instead of cloning.
   */
  readonly workspace: string;
  /** Scratch on the data disk, outside the repo (spills, notes). */
  readonly scratch = "/workspace/.anchor";

  private readonly lb: Hws;
  private readonly executor: HeyoGuestExecutor;
  private readonly processes = new Map<string, ProcessHandle>();
  private started = false;
  private destroyed = false;

  constructor(
    private readonly spec: SandboxSpec,
    private readonly cfg: HeyoSandboxConfig,
  ) {
    // Adopting keeps the retained deployment's id — same VM, same disk.
    this.id = spec.adopt ?? newSandboxId();
    this.workspace = spec.workspacePath ?? "/workspace/repo";
    this.lb = new Hws({ server: cfg.server, token: cfg.token });
    this.executor = new HeyoGuestExecutor((command, env) =>
      this.lb.exec(this.id, command, {
        env,
        timeoutSecs: 10,
        patienceMs: 20_000,
      }),
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    const imageKind = this.cfg.imageKind ?? "artifact";
    if (this.spec.image && imageKind !== "artifact") {
      throw new Error(
        "the heyo backend accepts a per-sandbox image only with imageKind \"artifact\"; dockerfile/git builds are provider-level",
      );
    }
    if (this.spec.egress === "none") {
      throw new Error(
        "the heyo backend has no egress control — it declares egressControl: false, so `none` would be a promise it cannot keep",
      );
    }

    if (this.spec.adopt) {
      // Adopt the retained deployment: wake it and verify the workspace is
      // still there. Refreshing git identity + credentials is idempotent.
      try {
        await this.lb.patchScaling(this.id, { min_replicas: 1 });
        await this.lb.waitForReady(this.id, {
          timeoutMs: this.cfg.readyTimeoutMs ?? 900_000,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A deployment the control plane no longer knows is gone; a timeout
        // waiting for it to wake is transient and must be retried.
        if (/\bnot found\b|\bdoes not exist\b|\b404\b/i.test(message)) {
          throw new SandboxGoneError(
            `retained sandbox ${this.id} no longer exists: ${message}`,
            this.id,
          );
        }
        throw new Error(`retained sandbox ${this.id} is unavailable: ${message}`);
      }
      await this.ensureGit();
      await this.setupGitCredentials();
      const probe = await this.guest(
        `[ -d ${this.workspace}/.git ] && echo ok || echo missing`,
        { cwd: "/", timeoutSecs: 30 },
      );
      if (probe.stdout.trim() !== "ok")
        throw new SandboxGoneError(
          `retained sandbox ${this.id} has no workspace`,
          this.id,
        );
      await this.prepareScratch();
      this.started = true;
      return;
    }

    // Register the deployment (private: no routes) and boot it. The image
    // comes from the namespace store: a prebuilt artifact, or a Dockerfile
    // manifest the host builds itself.
    const imageSource =
      imageKind === "dockerfile"
        ? {
            build: {
              store: this.cfg.imageStore ?? "https://hub.heyo.work",
              ref: this.cfg.image,
              ...(this.cfg.imageSizeMb
                ? { image_size_mb: this.cfg.imageSizeMb }
                : {}),
            },
          }
        : imageKind === "git"
          ? {
              build: {
                repo: this.cfg.imageRepo,
                ref: this.cfg.imageRef,
                dockerfile: this.cfg.imageDockerfile ?? "Dockerfile",
                ...(this.cfg.imageContext
                  ? { context: this.cfg.imageContext }
                  : {}),
                ...(this.cfg.imageAuth ? { auth: this.cfg.imageAuth } : {}),
                ...(this.cfg.imageSizeMb
                  ? { image_size_mb: this.cfg.imageSizeMb }
                  : {}),
              },
            }
          : {
              artifact: {
                store: this.cfg.imageStore ?? "https://hub.heyo.work",
                ref: this.spec.image ?? this.cfg.image,
              },
            };
    await this.lb.createDeployment({
      id: this.id,
      namespace: this.cfg.namespace,
      routes: [],
      ...imageSource,
      vm: {
        driver: "firecracker",
        port: 22,
        size_class: this.cfg.sizeClass,
        disk_size_gb: this.cfg.diskSizeGb,
      },
      health: { path: null }, // ready once sshd accepts a connection
      scaling: {
        min_replicas: 0,
        max_replicas: 1,
        scale_to_zero_after_secs: 600,
        idle_action: "retain", // keep the /workspace disk between stops
      },
    });
    // Prebuilt image → pull it (no-op after the first pull); Dockerfile
    // manifest or git source → the host builds the rootfs (slower the very
    // first time).
    const job =
      imageKind === "artifact"
        ? await this.lb.startPull(this.id)
        : await this.lb.startBuild(this.id);
    // A failed job is an answer, not an exception: waitForJob resolves and the
    // record carries the builder's log. Surface it instead of blaming readiness.
    const finished = await this.lb.waitForJob(job.id, {
      deployment: this.id,
    });
    if (finished.status !== "succeeded") {
      const tail = finished.log.slice(-8).join("\n");
      throw new Error(
        `image ${imageKind} job ${finished.status}: ${
          finished.error ?? tail ?? "no builder log"
        }`,
      );
    }
    await this.lb.patchScaling(this.id, { min_replicas: 1 });
    await this.lb.waitForReady(this.id, {
      timeoutMs: this.cfg.readyTimeoutMs ?? 900_000,
    });

    await this.ensureGit();
    if (this.spec.workspacePath) {
      // The image already contains the repo (SWE-bench's /testbed). Verify it
      // and configure identity; never clone over the provisioned environment.
      await this.verifyWorkspace();
      await this.configureGitIdentity();
    } else {
      await this.setupGitCredentials();
      await this.cloneRepo();
    }
    await this.prepareScratch();
    this.started = true;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertUsable();
    return this.guest(command, { ...opts, cwd: opts.cwd ?? this.workspace });
  }

  async openProcess(
    command: string,
    args: string[],
    opts: ProcessOptions = {},
  ): Promise<ProcessHandle> {
    this.assertUsable();
    if (this.processes.size >= 8) {
      throw new Error("heyo sandbox process limit reached (8)");
    }
    const id = randomUUID();
    const timeoutSecs = clampTimeout(opts.timeoutSecs ?? 3600);
    const pidFile = `/tmp/anchor-proc-${id}.pid`;
    const marker = `__ANCHOR_PROC_${id}__`;
    const env = { ...this.spec.env, ...opts.env };
    const envArgs = Object.entries(env).map(([key, value]) => shq(`${key}=${value}`));
    const inner = `printf %s ${shq(marker)}; echo $$ > ${shq(pidFile)}; exec "$@"`;
    const launch =
      `exec env ${envArgs.join(" ")} sh -c ${shq(inner)} anchor ` +
      [command, ...args].map(shq).join(" ");

    const shell = await this.lb.shell(this.id, {
      cwd: opts.cwd ?? this.workspace,
      wake: true,
    });
    const stdout = new ByteQueue();
    const stderr = new ByteQueue();
    const pending: Array<string | Uint8Array> = [];
    let started = false;
    let endRequested = false;
    let prefix = "";
    let finished:
      | { exitCode: number; signal?: string; timedOut: boolean }
      | undefined;
    let timedOut = false;

    const finish = (exitCode: number) => {
      if (finished) return finished;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      stdout.close();
      stderr.close();
      this.processes.delete(id);
      finished = { exitCode, timedOut };
      return finished;
    };

    shell.onData((data) => {
      if (started) {
        stdout.push(data);
        return;
      }
      prefix += Buffer.from(data).toString("utf8");
      const at = prefix.indexOf(marker);
      if (at < 0) {
        if (prefix.length > marker.length + 8192) {
          prefix = prefix.slice(-marker.length);
        }
        return;
      }
      started = true;
      const after = prefix.slice(at + marker.length);
      prefix = "";
      if (after) stdout.push(Buffer.from(after, "utf8"));
      for (const data of pending.splice(0)) shell.write(data);
      if (endRequested) shell.write("\x04");
    });
    shell.onError((message) => stderr.push(Buffer.from(message)));

    const timer = setTimeout(() => {
      timedOut = true;
      void kill("SIGKILL");
    }, timeoutSecs * 1000);
    const abort = () => {
      timedOut = true;
      void kill("SIGKILL");
    };
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }

    const exitPromise = shell.exit
      .then((exit) => finish(exit.clean ? exit.code : exit.code || -1))
      .catch(() => finish(-1));

    const kill = async (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
      if (finished) return false;
      const guestSignal = signal === "SIGKILL" ? "KILL" : "TERM";
      await this.lb
        .exec(
          this.id,
          `p=$(cat ${shq(pidFile)} 2>/dev/null) || exit 0; kill -${guestSignal} -$p 2>/dev/null || kill -${guestSignal} $p 2>/dev/null || true; rm -f ${shq(pidFile)}`,
          { timeoutSecs: 10, patienceMs: 20_000 },
        )
        .catch(() => undefined);
      await shell.close().catch(() => undefined);
      return true;
    };

    const handle: ProcessHandle = {
      id,
      stdout,
      stderr,
      write: async (data) => {
        if (!started) {
          pending.push(data);
          return;
        }
        shell.write(data);
      },
      endInput: async () => {
        if (!started) {
          endRequested = true;
          return;
        }
        shell.write("\x04");
      },
      wait: () => exitPromise,
      kill,
    };
    this.processes.set(id, handle);
    // `stty -echo` keeps the launch line out of the command's stream; the
    // marker lets us drop the shell prompt and any terminal setup chatter.
    shell.write(`stty -echo\n${launch}\n`);
    return handle;
  }

  async pollJob(
    jobId: string,
    meta?: { startedAt?: number; timeoutSecs?: number },
  ): Promise<ExecResult | undefined> {
    this.assertUsable();
    return this.executor.poll(jobId, meta);
  }

  async killJob(jobId: string): Promise<boolean> {
    this.assertUsable();
    return this.executor.kill(jobId);
  }

  async killAllJobs(): Promise<number> {
    this.assertUsable();
    return this.executor.killAll();
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
    // Heyo's native path is different from a copy: the sandbox is retained
    // (idle_action: retain), so a resume WAKES the same VM and finds the
    // checkpoint commit already there — no data movement at all. Forking to a
    // *different* VM needs the checkpoint to leave the machine (git bundle or
    // a push to a remote); that lands with best-of-N-on-Heyo (step 14).
    throw new Error(
      "fork() is not implemented for the heyo backend yet — resume uses the retained sandbox (wake) instead",
    );
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    for (const handle of [...this.processes.values()]) {
      await handle.kill("SIGKILL").catch(() => undefined);
      await handle.wait().catch(() => undefined);
    }
    this.processes.clear();
    // Parking scales the VM to zero, which kills live processes. Wait for
    // background jobs to finish — the consumer parks the sandbox after its
    // last poll.
    if (this.executor.hasJobs()) {
      process.stderr.write(
        `deferring sandbox park: background job still running on ${this.id} (namespace ${this.cfg.namespace})\n`,
      );
      return;
    }
    this.destroyed = true;
    if (this.spec.keep || this.spec.retain) {
      // Stop burning compute; keep the /workspace disk so a later run can
      // wake this VM (retain) or a human can inspect it (keep).
      await this.lb
        .patchScaling(this.id, { min_replicas: 0 })
        .catch(() => undefined);
      process.stderr.write(
        this.spec.keep
          ? `keeping sandbox for debugging: ${this.id} (namespace ${this.cfg.namespace})\n`
          : `retained sandbox for thread continuation: ${this.id} (namespace ${this.cfg.namespace})\n`,
      );
      return;
    }
    try {
      await this.lb.deleteDeployment(this.id);
    } catch (err) {
      // Delete is idempotent: already-gone is success.
      const message = err instanceof Error ? err.message : String(err);
      if (!/not.?found|404/i.test(message)) throw err;
    }
  }

  // --- internals -----------------------------------------------------------

  private assertUsable(): void {
    if (!this.started)
      throw new Error(`sandbox ${this.id} not started — call start() first`);
    if (this.destroyed) throw new Error(`sandbox ${this.id} was destroyed`);
  }

  /** Raw guest call — no started/destroyed checks (start() itself uses this). */
  private gitAccess(): GitAccess {
    return {
      git: async (args, opts) => {
        const r = await this.exec(
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
      shell: (command, opts) => this.exec(command, opts),
    };
  }

  /** The reserved .anchor dir: git-excluded (status/diff), checkpoint-carried. */
  private async prepareScratch(): Promise<void> {
    await this.guest(reservedScratchPrepCommand(), {
      cwd: this.workspace,
      timeoutSecs: 60,
    });
  }

  private async guest(command: string, opts: ExecOptions): Promise<ExecResult> {
    const timeoutSecs = clampTimeout(opts.timeoutSecs);
    const cwd = opts.cwd ?? "/";
    // Our own `cd` is the source of truth (see buildGuestCommand); the exec
    // options carry env only.
    const wrapped = buildGuestCommand(command, timeoutSecs, cwd);
    const result = await this.executor.run(
      wrapped,
      timeoutSecs,
      {
        ...this.spec.env,
        ...opts.env,
      },
      {
        concurrent: opts.concurrent,
        ...(opts.backgroundAfterSecs !== undefined
          ? { backgroundAfterSecs: opts.backgroundAfterSecs }
          : {}),
      },
    );
    // A detached job only survives if the VM does. Make retention a property
    // of the result, not a caller convention nobody can remember.
    if (result.background) this.spec.retain = true;
    return result;
  }

  /** heyo/bun has git; other images may not. The guest job handles a long
   * installation without holding one API request open or polling blindly. */
  private async ensureGit(): Promise<void> {
    const probe = await this.guest("command -v git || true", {
      cwd: "/",
      timeoutSecs: 60,
    });
    if (probe.exitCode !== 0)
      throw new Error(
        `Guest capability probe failed; Git availability is unknown: ${probe.output.trim()}`,
      );
    if (probe.stdout.trim() !== "") return;

    const install = await this.guest(
      "apt-get update -qq && apt-get install -y -qq git",
      { cwd: "/", timeoutSecs: 240 },
    );
    if (install.exitCode !== 0)
      throw new Error(
        `Git installation did not complete successfully: ${install.output.trim()}`,
      );
    const again = await this.guest("command -v git || true", {
      cwd: "/",
      timeoutSecs: 30,
    });
    if (again.exitCode !== 0 || !again.stdout.trim())
      throw new Error(
        `Git availability could not be confirmed: ${again.output.trim()}`,
      );
  }

  /** Git credentials for private repos — written outside /workspace, never in the repo. */
  private async setupGitCredentials(): Promise<void> {
    // The spec's callback wins (it re-mints per start/adopt); the config
    // string stays honored for compatibility.
    const tokenFor =
      this.spec.git?.token ??
      (this.cfg.githubToken ? () => this.cfg.githubToken! : undefined);
    if (!tokenFor) return;
    // https repos only, and the host comes from the repo URL unless named —
    // any git host works (Bitbucket, Azure DevOps, self-hosted), not only
    // github.com. ssh/git@ URLs authenticate via the key instead.
    const host = this.spec.git?.host ?? httpsHost(this.spec.repoUrl);
    if (!host) return;
    const username = this.spec.git?.username ?? "x-access-token";
    const token = await tokenFor();
    const creds = Buffer.from(
      `https://${username}:${token}@${host}\n`,
    ).toString("base64");
    const r = await this.guest(
      [
        `echo ${shq(creds)} | base64 -d > /etc/git-credentials && chmod 600 /etc/git-credentials`,
        `git config --global credential.helper "store --file=/etc/git-credentials"`,
      ].join(" && "),
      { cwd: "/", timeoutSecs: 60 },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `git credential setup failed (${r.exitCode}): ${r.output.trim()}`,
      );
    }
  }

  /** An image-provisioned workspace must already be a git checkout. */
  private async verifyWorkspace(): Promise<void> {
    const probe = await this.guest(`test -d ${shq(this.workspace)}/.git`, {
      cwd: "/",
      timeoutSecs: 30,
    });
    if (probe.exitCode !== 0) {
      throw new Error(
        `workspacePath ${this.workspace} is not a git repository — ` +
          "the configured image must contain the checkout",
      );
    }
  }

  private async configureGitIdentity(): Promise<void> {
    const gitName = this.spec.gitIdentity?.name ?? "anchor";
    const gitEmail = this.spec.gitIdentity?.email ?? "anchor@localhost";
    const identity = await this.guest(
      `git config --global user.name ${shq(gitName)} && git config --global user.email ${shq(gitEmail)}`,
      { cwd: "/", timeoutSecs: 60 },
    );
    if (identity.exitCode !== 0) {
      throw new Error(`git identity setup failed: ${identity.output.trim()}`);
    }
  }

  private async cloneRepo(): Promise<void> {
    await this.guest(`mkdir -p ${shq(this.workspace)}`, {
      cwd: "/",
      timeoutSecs: 60,
    });
    await this.configureGitIdentity();

    if (!this.spec.repoUrl) {
      const init = await this.guest(`git init -q -b main`, {
        cwd: this.workspace,
        timeoutSecs: 60,
      });
      if (init.exitCode !== 0)
        throw new Error(`git init failed: ${init.output.trim()}`);
      return;
    }

    const clone = await this.guest(
      `git clone -q ${shq(this.spec.repoUrl)} ${this.workspace}`,
      {
        cwd: "/",
        timeoutSecs: 600,
      },
    );
    if (clone.exitCode !== 0) {
      throw new Error(
        `git clone failed (${clone.exitCode}): ${clone.output.trim()}`,
      );
    }
    if (this.spec.ref) {
      const checkout = await this.guest(
        `git checkout -q ${shq(this.spec.ref)}`,
        {
          cwd: this.workspace,
          timeoutSecs: 120,
        },
      );
      if (checkout.exitCode !== 0) {
        throw new Error(
          `git checkout ${this.spec.ref} failed: ${checkout.output.trim()}`,
        );
      }
    }
  }
}
