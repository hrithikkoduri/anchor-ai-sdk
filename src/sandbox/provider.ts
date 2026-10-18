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
  /** Provider-specific flags, addable without breaking the contract. */
  [flag: string]: boolean;
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
}
