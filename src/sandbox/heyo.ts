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
export function buildGuestCommand(command: string, timeoutSecs: number, cwd: string): string {
  const inner = `cd ${shq(cwd)} && ${command}`;
  return `timeout -k 5 ${timeoutSecs} bash -c ${shq(inner)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HeyoSandbox implements Sandbox {
  readonly backend = "heyo" as const;
  readonly id: string;
  /** The repo path inside the VM (the /workspace data disk). */
  readonly workspace = "/workspace/repo";

  private readonly lb: Hws;
  private started = false;
  private destroyed = false;

  constructor(
    private readonly spec: SandboxSpec,
    private readonly cfg: HeyoSandboxConfig,
  ) {
    this.id = newSandboxId();
    this.lb = new Hws({ server: cfg.server, token: cfg.token });
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
    if (add.exitCode !== 0) throw new Error(`git add failed (${add.exitCode}): ${add.output.trim()}`);
    const commit = await this.exec(`git commit -q --allow-empty -m ${shq(message)}`, { timeoutSecs: 120 });
    if (commit.exitCode !== 0) throw new Error(`git commit failed (${commit.exitCode}): ${commit.output.trim()}`);
    const rev = await this.exec(`git rev-parse HEAD`, { timeoutSecs: 60 });
    if (rev.exitCode !== 0) throw new Error(`git rev-parse failed: ${rev.output.trim()}`);
    return { sha: rev.stdout.trim(), message, at: Date.now() };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.spec.keep) {
      // Stop burning compute; keep the disk so the VM can be inspected later.
      await this.lb.patchScaling(this.id, { min_replicas: 0 }).catch(() => undefined);
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
    if (!this.started) throw new Error(`sandbox ${this.id} not started — call start() first`);
    if (this.destroyed) throw new Error(`sandbox ${this.id} was destroyed`);
  }

  /** Raw guest call — no started/destroyed checks (start() itself uses this). */
  private async guest(command: string, opts: ExecOptions): Promise<ExecResult> {
    const timeoutSecs = clampTimeout(opts.timeoutSecs);
    const cwd = opts.cwd ?? "/";
    // Our own `cd` is the source of truth (see buildGuestCommand); the exec
    // options carry env only.
    const wrapped = buildGuestCommand(command, timeoutSecs, cwd);
    const startedAt = Date.now();
    try {
      const r = await this.lb.exec(this.id, wrapped, {
        env: { ...this.spec.env, ...opts.env },
        // The API deadline must outlive the guest deadline; the guest-side
        // `timeout` is what actually kills the command.
        timeoutSecs: Math.min(3600, timeoutSecs + 60),
        patienceMs: (timeoutSecs + 90) * 1000,
      });
      // 124 = timed out, 137 = killed hard (128 + SIGKILL) — shell conventions.
      const timedOut = r.exit_code === 124 || r.exit_code === 137;
      return {
        exitCode: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        output: r.output,
        timedOut,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      // The API call itself failed (transport, patience). The guest-side
      // `timeout` still reaps the process; we just cannot read its output.
      const message = err instanceof Error ? err.message : String(err);
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${message}\n`,
        output: `${message}\n`,
        timedOut: true,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /** heyo/bun has git; heyo/debian does not — install it in the background and wait. */
  private async ensureGit(): Promise<void> {
    const probe = await this.guest("command -v git || true", { cwd: "/", timeoutSecs: 60 });
    if (probe.stdout.trim() !== "") return;

    await this.guest(
      "nohup sh -c 'apt-get update -qq && apt-get install -y -qq git' >/tmp/git-install.log 2>&1 &",
      { cwd: "/", timeoutSecs: 30 },
    );
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const again = await this.guest("command -v git || true", { cwd: "/", timeoutSecs: 30 });
      if (again.stdout.trim() !== "") return;
    }
    throw new Error("git did not become available in the guest within 3 minutes");
  }

  /** Git credentials for private repos — written outside /workspace, never in the repo. */
  private async setupGitCredentials(): Promise<void> {
    if (!this.cfg.githubToken || !this.spec.repoUrl?.includes("github.com")) return;
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
      throw new Error(`git credential setup failed (${r.exitCode}): ${r.output.trim()}`);
    }
  }

  private async cloneRepo(): Promise<void> {
    await this.guest(`mkdir -p ${this.workspace}`, { cwd: "/", timeoutSecs: 60 });
    const identity = await this.guest(
      `git config --global user.name "harness" && git config --global user.email "harness@localhost"`,
      { cwd: "/", timeoutSecs: 60 },
    );
    if (identity.exitCode !== 0) {
      throw new Error(`git identity setup failed: ${identity.output.trim()}`);
    }

    if (!this.spec.repoUrl) {
      const init = await this.guest(`git init -q -b main`, { cwd: this.workspace, timeoutSecs: 60 });
      if (init.exitCode !== 0) throw new Error(`git init failed: ${init.output.trim()}`);
      return;
    }

    const clone = await this.guest(`git clone -q ${shq(this.spec.repoUrl)} ${this.workspace}`, {
      cwd: "/",
      timeoutSecs: 600,
    });
    if (clone.exitCode !== 0) {
      throw new Error(`git clone failed (${clone.exitCode}): ${clone.output.trim()}`);
    }
    if (this.spec.ref) {
      const checkout = await this.guest(`git checkout -q ${shq(this.spec.ref)}`, {
        cwd: this.workspace,
        timeoutSecs: 120,
      });
      if (checkout.exitCode !== 0) {
        throw new Error(`git checkout ${this.spec.ref} failed: ${checkout.output.trim()}`);
      }
    }
  }
}
