/**
 * The built-in providers and the legacy options → provider bridge.
 *
 * Heyo imports the platform SDK (inside `heyo.ts`, its single boundary);
 * `local` runs on the host. Consumers should import factories from their
 * subpaths — `@anchor/core/sandbox/heyo`, `@anchor/core/sandbox/local` — so
 * an SDK loads only for the backends actually used.
 */
import { HeyoSandbox, probeHeyo, type HeyoSandboxConfig } from "./heyo.js";
import { LocalSandbox, type LocalSandboxOptions } from "./local.js";
import type { SandboxProvider } from "./provider.js";

/** Heyo Cloud microVMs. */
export function heyo(cfg: HeyoSandboxConfig): SandboxProvider {
  return {
    name: "heyo",
    capabilities: {
      fork: false,
      retain: true,
      remoteCheckpoint: true,
      egressControl: false,
    },
    create: (spec) => new HeyoSandbox(spec, cfg),
    adopt: (handle, spec = {}) =>
      new HeyoSandbox({ ...spec, adopt: handle.id }, cfg),
    release: async (handle) => {
      await new HeyoSandbox({ adopt: handle.id }, cfg).destroy();
    },
    probe: () => probeHeyo(cfg),
  };
}

/** The host machine — dev and tests; never isolation. */
export function local(opts: LocalSandboxOptions = {}): SandboxProvider {
  return {
    name: "local",
    capabilities: {
      fork: false,
      retain: true,
      remoteCheckpoint: true,
      egressControl: false,
    },
    create: (spec) => new LocalSandbox(spec, opts),
    adopt: (handle, spec = {}) =>
      new LocalSandbox({ ...spec, adopt: handle.id }, opts),
    release: async (handle) => {
      await new LocalSandbox({ adopt: handle.id }, opts).destroy();
    },
    probe: async () => ({ ok: true, name: "local" }),
  };
}

/** The legacy options shape (`{ local } | { heyo }`) — consumers migrating
 * to explicit providers can drop it entirely. */
export type CreateSandboxOptions = {
  /**
   * Run locally instead of in a microVM. Dev/test only — set by the `--local`
   * CLI flag or directly by tests; never by configuration.
   */
  local?: boolean | LocalSandboxOptions;
  /** Heyo connection. Required unless `local` is set. */
  heyo?: HeyoSandboxConfig;
};

export function providerFor(opts: CreateSandboxOptions): SandboxProvider {
  if (opts.local)
    return local(typeof opts.local === "object" ? opts.local : {});
  if (!opts.heyo?.token) {
    throw new Error(
      "the heyo backend needs a token — set HEYO_TOKEN in .env (and HEYO_NAMESPACE), or pass --local",
    );
  }
  return heyo(opts.heyo);
}
