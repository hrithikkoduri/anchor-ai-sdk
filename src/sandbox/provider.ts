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
import type { ImagePublisher } from "./image.js";
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
  /** Persistent stdin/stdout process streams (`Sandbox.openProcess`). */
  processStream?: boolean;
  /** An `imagePublisher` is present and can publish a provider image. */
  publishImage?: boolean;
  /** `Sandbox.exposePort()` is implemented. */
  previewPort: boolean;
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
   * Optional: is this error from `adopt(...).start()` proof the sandbox is
   * truly gone (safe to clear the pointer and build fresh), as opposed to a
   * transient failure (retry)? Adapters that can tell the difference — a
   * provider "not found" versus a lock/timeout — declare it here. Absent, an
   * error counts as gone only when it is a `SandboxGoneError`.
   */
  isGone?(error: unknown): boolean;
  /**
   * Optional image build/publish seam. `capabilities.publishImage` is the
   * capability declaration; consumers can call it before creating a sandbox
   * and pass the returned ref through `SandboxSpec.image` (or the provider
   * config for provider-level images such as Heyo).
   */
  imagePublisher?: ImagePublisher;
  /**
   * Optional provider-side preparation before the first sandbox of a run is
   * opened — refreshed credentials, warmed caches, quota checks. `gitToken`
   * mints a fresh git credential on demand. Best-effort by contract: the
   * CALLER decides whether a failure is fatal (the Heyo provider uses this to
   * refresh the build secret its git-kind image builds read).
   */
  prepare?(args: { gitToken?: () => Promise<string> }): Promise<void>;
}
