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
import { Hws } from "@heyocomputer/hws";
import { HeyoGuestExecutor } from "./heyo-exec.js";
import {
  clampTimeout,
  newSandboxId,
  shq,
  type Checkpoint,
  type ExecOptions,
  type ExecResult,
  type HeyoSizeClass,
  type Sandbox,
  type SandboxSpec,
} from "./types.js";

export interface HeyoSandboxConfig {
  token: string;
  server: string;
  namespace: string;
  /** VM image — heyo/bun:latest ships git + bun on Debian. */
  image: string;
  sizeClass: HeyoSizeClass;
  diskSizeGb: number;
  /** Used to clone private repos and later push PR branches; optional. */
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

export class HeyoSandbox implements Sandbox {
  readonly backend = "heyo" as const;
  readonly id: string;
  /** The repo path inside the VM (the /workspace data disk). */
  readonly workspace = "/workspace/repo";

  private readonly lb: Hws;
  private readonly executor: HeyoGuestExecutor;
  private started = false;
  private destroyed = false;

  constructor(
    private readonly spec: SandboxSpec,
    private readonly cfg: HeyoSandboxConfig,
  ) {
    this.id = newSandboxId();
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

    // Register the deployment (private: no routes) and boot it.
    await this.lb.createDeployment({
      id: this.id,
      namespace: this.cfg.namespace,
      routes: [],
      artifact: { store: "https://hub.heyo.work", ref: this.cfg.image },
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
    const pull = await this.lb.startPull(this.id); // no-op after first pull of this image
    await this.lb.waitForJob(pull.id);
    await this.lb.patchScaling(this.id, { min_replicas: 1 });
    await this.lb.waitForReady(this.id);

    await this.ensureGit();
    await this.setupGitCredentials();
    await this.cloneRepo();
    this.started = true;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertUsable();
    return this.guest(command, { ...opts, cwd: opts.cwd ?? this.workspace });
  }

  async checkpoint(message: string): Promise<Checkpoint> {
    this.assertUsable();
    const add = await this.exec(`git add -A`, { timeoutSecs: 120 });
    if (add.exitCode !== 0)
      throw new Error(`git add failed (${add.exitCode}): ${add.output.trim()}`);
    const commit = await this.exec(
      `git commit -q --allow-empty -m ${shq(message)}`,
      { timeoutSecs: 120 },
    );
    if (commit.exitCode !== 0)
      throw new Error(
        `git commit failed (${commit.exitCode}): ${commit.output.trim()}`,
      );
    const rev = await this.exec(`git rev-parse HEAD`, { timeoutSecs: 60 });
    if (rev.exitCode !== 0)
      throw new Error(`git rev-parse failed: ${rev.output.trim()}`);
    return { sha: rev.stdout.trim(), message, at: Date.now() };
  }

  async hasChangesFrom(ref: string): Promise<boolean> {
    this.assertUsable();

    // Best-effort refresh of remote-tracking refs (missing branch / no
    // network must not break the comparison — it fails open below).
    if (ref.startsWith("origin/")) {
      const branch = ref.slice("origin/".length);
      await this.exec(
        `git fetch --quiet origin ${shq(`+refs/heads/${branch}:refs/remotes/${ref}`)} 2>/dev/null || true`,
        {
          timeoutSecs: 120,
        },
      );
    }

    const refTree = await this.exec(
      `git rev-parse --verify --quiet ${shq(`${ref}^{tree}`)} || true`,
      {
        timeoutSecs: 60,
      },
    );
    const refTreeSha = refTree.stdout.trim();
    if (!refTreeSha) return true; // unresolvable ref → everything is new

    // Stage first (same trick as the freshness checks): uncommitted work counts.
    const add = await this.exec(`git add -A`, { timeoutSecs: 120 });
    const localTree = await this.exec(`git write-tree`, { timeoutSecs: 60 });
    const localTreeSha = localTree.stdout.trim();
    if (add.exitCode !== 0 || localTree.exitCode !== 0 || !localTreeSha)
      return true; // fail open
    return localTreeSha !== refTreeSha;
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
    this.destroyed = true;
    if (this.spec.keep) {
      // Stop burning compute; keep the disk so the VM can be inspected later.
      await this.lb
        .patchScaling(this.id, { min_replicas: 0 })
        .catch(() => undefined);
      process.stderr.write(
        `keeping sandbox for debugging: ${this.id} (namespace ${this.cfg.namespace})\n`,
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
  private async guest(command: string, opts: ExecOptions): Promise<ExecResult> {
    const timeoutSecs = clampTimeout(opts.timeoutSecs);
    const cwd = opts.cwd ?? "/";
    // Our own `cd` is the source of truth (see buildGuestCommand); the exec
    // options carry env only.
    const wrapped = buildGuestCommand(command, timeoutSecs, cwd);
    return this.executor.run(wrapped, timeoutSecs, {
      ...this.spec.env,
      ...opts.env,
    });
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
    if (!this.cfg.githubToken || !this.spec.repoUrl?.includes("github.com"))
      return;
    const creds = Buffer.from(
      `https://x-access-token:${this.cfg.githubToken}@github.com\n`,
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

  private async cloneRepo(): Promise<void> {
    await this.guest(`mkdir -p ${this.workspace}`, {
      cwd: "/",
      timeoutSecs: 60,
    });
    const identity = await this.guest(
      `git config --global user.name "anchor" && git config --global user.email "anchor@localhost"`,
      { cwd: "/", timeoutSecs: 60 },
    );
    if (identity.exitCode !== 0) {
      throw new Error(`git identity setup failed: ${identity.output.trim()}`);
    }

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
