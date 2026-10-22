/**
 * The SandboxProvider contract — how a backend plugs into Anchor.
 *
 * A provider owns one vocabulary: create/adopt/release/probe for its own
 * infrastructure. Everything above the `Sandbox` interface (agent loop,
 * tools, lifecycle) stays provider-agnostic: `provider.name` is a free-form
 * string, never a closed union, so a new backend cannot be silently
 * misclassified as an old one.
 *
 * Mechanics live here; policy — which provider, which image, retention
 * rules — belongs to the consumer.
 */
import type { Sandbox, SandboxSpec } from "./types.js";

/** What a provider can actually do — products degrade instead of guessing. */
export interface SandboxCapabilities {
  /** Start a second sandbox from a checkpoint (best-of-N races). */
  fork: boolean;
  /** Keep the sandbox/disk between runs; adopt by handle. */
  retain: boolean;
  /** Checkpoints can be pushed to a remote (survive a lost VM). */
  remoteCheckpoint: boolean;
  /** Network egress can be restricted per sandbox. */
  egressControl: boolean;
  /**
   * Reads `SandboxSpec.localPath` — can copy a directory from the provider's
   * own host. False for anything that runs on another machine; the
   * conformance suite gates its host-filesystem scenarios on this.
   */
  localPath: boolean;
  /**
   * `buildImage(spec)` is implemented — the provider can build and publish a
   * named machine image that later creates reference via `SandboxSpec.image`.
   */
  buildImage: boolean;
  /**
   * Provider-specific flags beyond the contract — declared, never implied.
   * (Deliberately not an index signature: a typo must not type-check as a
   * present capability.)
   */
  extra?: Record<string, boolean>;
}

/** A sandbox's coordinates — enough to re-open or release it later. */
export interface SandboxHandle {
  id: string;
  /** The provider name that owns this sandbox (free-form, stored verbatim). */
  backend: string;
}

export interface ProviderHealth {
  ok: boolean;
  name: string;
  /** Human-readable summary (server, scope, counts — the provider's choice). */
  detail?: string;
  /** Provider-specific structured extras (e.g. token scope) for `doctor`s. */
  info?: Record<string, unknown>;
}

/**
 * A machine image a consumer builds once and reuses — the publish step of the
 * publish-then-boot pattern every remote provider supports in its own
 * vocabulary (Daytona snapshot, E2B template, Heyo artifact).
 */
export interface ImageBuildSpec {
  /** The name later creates reference it by (`spec.image`). Provider-scoped. */
  name: string;
  /** A registry base image (e.g. `debian:bookworm`). Mutually exclusive with `dockerfile`. */
  fromImage?: string;
  /**
   * Path to a Dockerfile (host-side read). Mutually exclusive with `fromImage`.
   * The provider runs it through its own build pipeline; Heyo needs a
   * `heyvm.dockerfile.v1` manifest — a Dockerfile path is `git`-kind source.
   */
  dockerfile?: string;
  /** The directory the Dockerfile's build context lives in. Default: the Dockerfile's dir. */
  context?: string;
  /** Commands to run in the image after the base layer (the usual `apt-get install …`). */
  run?: string[];
  /**
   * Git source recipe (Daytona's `Image.fromDockerfile`-style build can take
   * this too; Heyo's git-kind build is built from it). Mutually exclusive
   * with `fromImage`/`dockerfile` on providers that build from git.
   */
  gitRepo?: string;
  /** Branch/tag/commit for `gitRepo`. Default: the remote's default branch. */
  gitRef?: string;
  /** Path of the Dockerfile inside `gitRepo`. Default: `Dockerfile`. */
  gitDockerfile?: string;
  /** vCPUs for the build. Default: the provider's own. */
  cpu?: number;
  /** Memory (MB) for the build. Default: the provider's own. */
  memoryMB?: number;
}

/** What a successful `buildImage` hands back. */
export interface ImageBuildResult {
  /** The exact string to pass as `SandboxSpec.image` on later creates. */
  name: string;
  /** The provider that owns it (for logging/multi-provider consumers). */
  provider: string;
}

export interface SandboxProvider {
  /** Stored verbatim on the sandbox and in consumer databases. */
  name: string;
  capabilities: SandboxCapabilities;
  /** A fresh sandbox from the spec (clone/init happens in start()). */
  create(spec: SandboxSpec): Sandbox;
  /**
   * A previously retained sandbox by handle. `spec` carries the fields the
   * consumer still wants applied (git identity, env); the workspace itself
   * comes from the retained disk. start() proves it still exists.
   */
  adopt(handle: SandboxHandle, spec?: SandboxSpec): Sandbox;
  /** Tear a retained sandbox down; already-gone is not an error. */
  release(handle: SandboxHandle): Promise<void>;
  /** Cheap connectivity/health check — what `doctor` calls. */
  probe(): Promise<ProviderHealth>;
  /**
   * Optional provider-side preparation before the first sandbox of a run is
   * opened — refreshed credentials, warmed caches, quota checks. `gitToken`
   * mints a fresh git credential on demand. Best-effort by contract: the
   * CALLER decides whether a failure is fatal (the Heyo provider uses this to
   * refresh the build secret its git-kind image builds read).
   */
  prepare?(args: { gitToken?: () => Promise<string> }): Promise<void>;
  /**
   * Build and publish a named machine image on the provider's own
   * infrastructure, so later `create`s boot from it without paying the build
   * again (`spec.image` = the returned `name`). Optional: declared via
   * `capabilities.buildImage`.
   */
  buildImage?(spec: ImageBuildSpec): Promise<ImageBuildResult>;
}
